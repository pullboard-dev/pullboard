/** A failure move creates a durable, unproved proposal without writing a repository file [D1,H16]. */
import {
  events,
  logEvent,
  PERSON,
  rowDecisions,
} from './board.js';
import { recordRowDraft } from './row-draft-store.js';
import { rowDrafts } from './board-query.js';
import {
  causeProblem,
  eventCauses,
  rigorReport,
  testCause,
} from './rigor.js';
import {
  conflictNoteFiles,
  conflictReport,
  splitProposal,
} from './rigor-conflicts.js';
import { NATIVE_FLAKE_ENGINE } from './flake-engine.js';
import {
  automaticDecisionSource,
  automaticRigorSource,
  automaticSourceFromText,
  readAutomaticRigorSource,
  rigorDecisionKey,
} from './rigor-auto-source.js';
import { RIGOR_AUTO_ENGINE } from './rigor-auto-engine.js';
import { REOPEN_CAUSE_ENGINE } from './reopen-cause-engine.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { conflictCause } from './reopen-cause.js';

/** Prefer structured exact-head failures; a coded fallback is a coarse category, never a root-cause finding. */
export function deriveRigorCause(board, item, { cause, reason, conflict, landingFailure, agentId }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_CAUSE_ENGINE && conflict?.files?.length) return conflictCause(conflict.files);
  if (cause !== undefined && cause !== null) return { cause };
  if (conflict?.files?.length) return conflictCause(conflict.files);
  const landing = landingFailure?.tests?.find(failure => !causeProblem(testCause(failure)));
  if (landing) return { cause: testCause(landing), causeDerivation: { kind: 'landing-failure', mergeCommit: landingFailure.mergeCommit } };
  const history = events(board);
  const submitted = history.findLast(event => event.item_id === item.item_id && event.event_kind === 'submit')?.event_id ?? 0;
  const failure = history.findLast(event => {
    if (event.event_id <= submitted || event.event_kind !== 'flake-observation' || event.event_by !== agentId) return false;
    const detail = JSON.parse(event.event_detail);
    const observation = detail.observation;
    return detail.engine === NATIVE_FLAKE_ENGINE && observation?.kind === 'verify' && observation.head === item.item_commit
      && observation.original?.green === false && typeof observation.file === 'string' && typeof observation.name === 'string'
      && !causeProblem(testCause(observation));
  });
  if (failure) return { cause: testCause(JSON.parse(failure.event_detail).observation),
    causeDerivation: { kind: 'recorded-failure', event: failure.event_id } };
  return { cause: `refusal:${reason ?? 'REOPENED'}`, causeDerivation: { kind: reason ? 'verdict-reason' : 'reopen-category', coarse: true } };
}

/** A decline covers every item seen by the actual decision, including repeats that preceded that decision. */
function proposalSuppressed(board, history, draft, cause) {
  const source = automaticSourceFromText(draft.text);
  if (readAutomaticRigorSource(source)?.key !== cause.key) return false;
  const decision = rowDecisions(board).findLast(record => record.kind === draft.target
    && (record.id === draft.id && automaticDecisionSource(record) === source
      || record.event > draft.event && rigorDecisionKey(record) === cause.key));
  if (!decision || decision.decision === 'approve') return true;
  const seen = new Set(history.filter(event => event.event_id <= decision.event).flatMap(event => {
    const detail = JSON.parse(event.event_detail);
    const matches = cause.key.startsWith('conflict:')
      ? event.event_kind === 'reopen' && detail.conflict?.files?.includes(cause.split.file)
        || event.event_kind === 'hold_item' && conflictNoteFiles(detail.reason)?.includes(cause.split.file)
      : eventCauses(event).includes(cause.key)
        || event.event_kind === 'fact' && event.event_by === PERSON && detail.neverAgain === true && detail.cause === cause.key;
    return matches && event.item_id !== null ? [event.item_id] : [];
  }));
  return !cause.items.some(item => !seen.has(item.id));
}

/** Draft the existing threshold's ordinary advice inside its triggering board transaction, never proving it. */
export function recordAutomaticRigorDrafts(board, trigger, shout) {
  const history = events(board);
  const detail = JSON.parse(trigger.event_detail);
  const keys = new Set(eventCauses(trigger));
  if (trigger.event_kind === 'fact' && trigger.event_by === PERSON && detail.neverAgain) keys.add(detail.cause);
  const causes = rigorReport(history, { person: PERSON }).causes.filter(cause => keys.has(cause.key));
  const conflicts = conflictReport(history, { now: board.clock.now() }).hotFiles
    .filter(file => trigger.event_kind === 'reopen' && detail.conflict?.files?.includes(file.file)
      || trigger.event_kind === 'hold_item' && conflictNoteFiles(detail.reason)?.includes(file.file))
    .map(file => ({ key: `conflict:${encodeURI(file.file)}`, reads: 'work', items: file.items.map(id => ({ id, commits: [] })),
      occurrences: file.events.length, neverAgain: false, split: file }));
  for (const cause of [...causes, ...conflicts]) {
    const eventIds = cause.split ? cause.split.events.map(event => event.id)
      : history.filter(event => eventCauses(event).includes(cause.key)
        || event.event_kind === 'fact' && event.event_by === PERSON && JSON.parse(event.event_detail).cause === cause.key).map(event => event.event_id);
    const targets = cause.reads === 'both' ? ['doctrine', 'spec'] : [cause.reads === 'product' ? 'spec' : 'doctrine'];
    const created = [];
    for (const target of targets) {
      if (rowDrafts(board).some(draft => draft.target === target && proposalSuppressed(board, history, draft, cause))) continue;
      const source = automaticRigorSource(cause, eventIds);
      const advice = cause.split ? splitProposal(cause.split).text
        : `Review how to prevent repeated ${JSON.stringify(cause.key).replaceAll('|', '\\u007c')} (${cause.items.map(item => `#${item.id}`).join(', ') || 'person-marked never again'}). No remedy or red/green proof has been established.`;
      const entry = recordRowDraft(board, { agentId: 'rigor', row: { id: `RG${trigger.event_id}1`, target,
        text: `${advice} Source: ${source}`, gate: 'review', tier: 'aim', section: 'RG' } });
      logEvent(board, 'rigor', 'rigor-draft', null, { engine: RIGOR_AUTO_ENGINE, id: entry.id, target, cause: cause.key,
        source, unproved: true, items: cause.items, occurrences: cause.occurrences });
      created.push({ id: entry.id, target });
    }
    if (created.length) {
      logEvent(board, 'rigor', 'rigor-notice', null, { engine: RIGOR_AUTO_ENGINE, cause: cause.key,
        items: cause.items, occurrences: cause.occurrences, neverAgain: cause.neverAgain, drafts: created });
      shout(board, { from: 'rigor', to: 'coordinator', text: `Rigor recorded unproved ${created.map(entry => `${entry.target} draft ${entry.id}`).join(' and ')} for ${cause.key}, from ${cause.items.map(item => `#${item.id}`).join(', ') || 'the person’s never-again decision'}. It is in Needs you; no rule was approved or applied.` });
    }
  }
}
