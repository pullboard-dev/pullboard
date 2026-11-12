/** Automatic repeated-cause notices and proved rows waiting on the person [D1,D3,S1]. */
import {
  causeProblem,
  eventCauses,
  isMergeConflict,
  rigorReport,
} from '../../../store/index.js';
import { parseSpec } from '../../../spec/index.js';
import {
  automaticRigorNeeds,
  automaticSourceFromText,
  readAutomaticRigorSource,
} from '../../../store/index.js';
import { RIGOR_AUTO_ENGINE } from '../../../state/light.js';
import {
  readRigorSource,
  RIGOR_NOTICE_ENGINE,
} from '../../../store/index.js';

/** Cause keys carried by this move, including the person's immediate never-again fact. */
export function rigorTriggerCauses(event, person) {
  if (event.event_kind === 'fact' && event.event_by === person) {
    const detail = JSON.parse(event.event_detail);
    if (detail.neverAgain === true && typeof detail.cause === 'string' && !causeProblem(detail.cause)) return [detail.cause];
  }
  return eventCauses(event);
}

/** Ignore an unreadable historical row source; it cannot establish a person’s typed decline. */
function declinedRigorSource(source) {
  if (typeof source !== 'string') return null;
  let rows;
  try { rows = parseSpec(`## Source\n${source}\n`).rows; }
  catch { return null; } // Historical metadata is optional; a parser refusal must never abort the original item move.
  return rows.length === 1 ? readRigorSource(rows[0].source)
    ?? readAutomaticRigorSource(automaticSourceFromText(rows[0].text)) : null;
}

/** Reconstruct notice and exact person-decline state from ordered receipts, never free text. */
function noticeState(events, person) {
  const seen = new Map();
  const notified = new Map();
  const declined = new Map();
  for (const event of events) {
    for (const key of rigorTriggerCauses(event, person)) {
      if (!seen.has(key)) seen.set(key, new Set());
      if (event.item_id !== null) seen.get(key).add(event.item_id);
    }
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'rigor-notice' && event.event_by === 'rigor' && [RIGOR_NOTICE_ENGINE, RIGOR_AUTO_ENGINE].includes(detail.engine)
      && typeof detail.cause === 'string' && !causeProblem(detail.cause)) notified.set(detail.cause, event.event_id);
    if (event.event_kind !== 'row_decision' || event.event_by !== person || detail.record?.decision !== 'decline') continue;
    const source = declinedRigorSource(detail.record.source);
    if (source) declined.set(source.key, { event: event.event_id, items: new Set(seen.get(source.key) ?? []) });
  }
  return { notified, declined };
}

/** A person's decline stays quiet until an item absent at that decision repeats the cause. */
function declinedRepeat(cause, state) {
  const decline = state.declined.get(cause.key);
  return Boolean(decline && !cause.items.some(item => !decline.items.has(item.id)));
}

/** The move that crosses the repeat threshold posts once, and a third failure stays quiet. */
export function newRigorNotices(events, trigger, { person }) {
  const keys = new Set(rigorTriggerCauses(trigger, person).filter(key => !isMergeConflict(key)));
  if (!keys.size) return [];
  const state = noticeState(events, person);
  return rigorReport(events, { person }).causes.filter(cause => {
    if (!keys.has(cause.key) || declinedRepeat(cause, state)) return false;
    const notice = state.notified.get(cause.key);
    const decline = state.declined.get(cause.key);
    return notice === undefined || Boolean(decline && notice < decline.event);
  });
}

/** Every typed Rigor row, across the spec and the repository's doctrine. */
function rigorRows(state) {
  return [...(state.spec ?? []).map(row => ({ ...row, kind: 'spec' })),
    ...(state.practice ?? []).filter(row => row.origin !== 'standard').map(row => ({ ...row, kind: 'doctrine' }))]
    .flatMap(row => { const source = readRigorSource(row.source); return source ? [{ row, source }] : []; });
}

/** Proved drafts are individual person calls, with their real evidence and both executed commits. */
export function rigorDraftNeeds(state, drafts = [], decisions = []) {
  return [...automaticRigorNeeds(state, drafts, decisions), ...rigorRows(state).filter(({ row }) => row.status === 'draft' && !row.decision).map(({ row, source }) => ({
    kind: 'rigor-draft', id: `${row.kind}:${row.id}`, ref: row.kind === 'doctrine' ? `doctrine:${row.id}` : row.id,
    text: `Rigor draft: ${row.text}`, what: 'Approve or Decline', target: `${row.kind}:${row.id}`,
    cause: source.key, evidence: source.evidence, proof: source.proof,
  }))];
}

/** Resume asks the coordinator to draft each repeated cause that has no live or approved proved row. */
export function undraftedRigor(events, state, { person, drafts = [], decisions = [] }) {
  const notices = noticeState(events, person);
  const drafted = new Set(rigorRows(state).filter(({ row }) => row.decision?.decision === 'approve'
    || (!row.decision && ['draft', 'pending', 'approved'].includes(row.status))).map(({ source }) => source.key));
  for (const need of automaticRigorNeeds(state, drafts, decisions)) drafted.add(need.cause);
  return rigorReport(events, { person }).causes.filter(cause => !drafted.has(cause.key) && !declinedRepeat(cause, notices));
}

/** One actionable notice names the cause and every item, with the ordinary proof-bearing draft command. */
export function rigorNoticeText(cause) {
  return `Repeated cause ${cause.key}: ${cause.items.map(item => `#${item.id}`).join(', ') || 'the person marked never again'}. Next: pullboard rigor draft "${cause.key.replaceAll('"', '\\"')}" "<rule>" --check "<command>" --red <commit> --green <commit>; prove the rule in this session, then the person approves or declines its draft.`;
}
