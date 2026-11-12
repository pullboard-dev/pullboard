/** Board-only proposed changes to approved requirements [P6,B23,N39]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import {
  defaultPrincipal,
  hasSignerFile,
  signRowDecision,
} from './signature.js';
import { draftRow } from './draft.js';
import {
  loadSpec,
  parseSpec,
  replaceRowGate,
  STATUSES,
} from './main.js';

/** Capture a target's exact current source, refusing ambiguous or unapproved targets. */
function approvedSource(root, config, id) {
  const spec = loadSpec(root, config);
  const matches = spec.rows.filter(row => row.id === id);
  if (matches.length !== 1 || matches[0].status !== 'approved') throw new Refused('SPEC_REVISION', `${id} must name one approved requirement; use pullboard spec show <id>`);
  return { row: matches[0], source: readFileSync(join(root, config.spec), 'utf8').split(/\r?\n/u)[matches[0].line - 1] };
}

/** Plan a new proposal without writing either the approved row or a draft row into SPEC.md. */
export function planSpecRevision(root, config, { revises, text, gate, status, reason, taken }, { loadDoctrine }) {
  if (typeof reason !== 'string' || !reason.trim() || /[\r\n|]/u.test(reason)) throw new Refused('SPEC_REVISION', 'give the reason for changing the approved row: --reason "why"');
  const { row, source } = approvedSource(root, config, revises);
  const wanted = status ?? row.status;
  if (!STATUSES.includes(wanted)) throw new Refused('SPEC_REVISION', `unknown status ${wanted}; use one of ${STATUSES.join(', ')}`);
  const nextGate = gate ?? row.gate;
  const nextText = text ?? row.text;
  if (nextText === row.text && nextGate === row.gate && wanted === row.status) throw new Refused('SPEC_REVISION', 'the proposed row is unchanged; give new text, gate or status');
  let replacement = source;
  if (wanted !== row.status) replacement = replacement.replace(/\[[a-z]+(?=,|\])/u, () => `[${wanted}`);
  if (nextText !== row.text) replacement = replacement.replace(/(\]\s+)([^|]*)/u,
    (_, start, old) => `${start}${nextText}${old.match(/\s*$/u)?.[0] ?? ''}`);
  if (nextGate !== row.gate) replacement = replaceRowGate(replacement, nextGate);
  const prefix = /^([A-Z][A-Z0-9]*?)\d+(?:\.\d+)*$/u.exec(revises)?.[1];
  const plan = draftRow(root, config, { target: 'spec', text: nextText, gate: nextGate, tier: row.tier, section: prefix, taken, write: false }, { loadDoctrine });
  return { ...plan.row, target: 'spec', revises, file: config.spec, source, replacement, status: wanted, reason: reason.trim() };
}

/** The signed reference includes the immutable complete proposal, not mutable display labels. */
export function revisionReference(draft) {
  return { proposal: draft.id, target: draft.revises, file: draft.file, source: draft.source,
    replacement: draft.replacement, reason: draft.reason, by: draft.by };
}

/** Validate the deterministic proposal payload before it enters the ordered board history. */
export function validSpecRevision(row) {
  const before = typeof row?.source === 'string' ? parseSpec(`## Revision\n${row.source}\n`).rows : [];
  const after = typeof row?.replacement === 'string' ? parseSpec(`## Revision\n${row.replacement}\n`).rows : [];
  return row?.target === 'spec' && typeof row.file === 'string' && row.file.trim()
    && typeof row.source === 'string' && !/[\r\n]/u.test(row.source)
    && typeof row.replacement === 'string' && !/[\r\n]/u.test(row.replacement)
    && typeof row.reason === 'string' && row.reason.trim() && !/[\r\n|]/u.test(row.reason)
    && before.length === 1 && before[0].status === 'approved' && before[0].id === row.revises
    && after.length === 1 && STATUSES.includes(after[0].status) && after[0].id === row.revises && after[0].text === row.text
    && after[0].gate === row.gate && after[0].status === row.status && row.source !== row.replacement
    && [...new Set([...Object.keys(before[0]), ...Object.keys(after[0])])].filter(key => !['text', 'gate', 'status', 'line', 'section'].includes(key))
      .every(key => JSON.stringify(before[0][key]) === JSON.stringify(after[0][key]));
}

/** Accept only the exact approved effect of a still-pending board proposal. */
export function validRevisionApproval(board, record, { rowDrafts, rowDecisions }) {
  const draft = rowDrafts(board).find(entry => entry.id === record.revision?.proposal);
  return Boolean(draft && !draft.decision && !draft.applied && validSpecRevision(draft) && record.decision === 'approve'
    && record.kind === 'spec' && record.id === draft.revises && record.file === draft.file
    && record.source === draft.source && record.replacement === draft.replacement && record.text === draft.text
    && JSON.stringify(record.revision) === JSON.stringify(revisionReference(draft))
    && !rowDecisions(board).some(current => current.kind === 'spec' && current.file === draft.file
      && current.id === draft.revises && !current.applied));
}

/** Build exact person decisions, retaining normal optional SSH signatures and current-source checks. */
export function prepareSpecRevisionDecisions(root, config, drafts, { ids, decision, reason = '', by, on, commit }) {
  const signed = decision === 'approve' && hasSignerFile(root);
  return ids.map(id => {
    const draft = drafts.find(entry => entry.id === id && entry.revises);
    if (!draft || draft.decision || draft.applied) throw new Refused('SPEC_REVISION', `${id} is not an undecided revision proposal; read Needs you`);
    if (decision === 'approve') {
      const current = approvedSource(root, config, draft.revises);
      if (draft.file !== config.spec || current.source !== draft.source) throw new Refused('STALE_ROW_DECISION', `${draft.revises} changed after ${id} was proposed; draft a fresh revision`);
    }
    if (decision === 'decline' && (!reason.trim() || /[\r\n|]/u.test(reason))) throw new Refused('SPEC_REVISION', 'declining a revision needs a one-line --reason "why"');
    const record = { version: 1, type: 'row-decision', kind: 'spec', file: draft.file, id: draft.revises,
      source: draft.source, replacement: draft.replacement, text: draft.text, decision,
      reason: decision === 'decline' ? reason.trim() : '', by: by ?? (signed ? defaultPrincipal(root) : 'person'),
      on, commit, note: '', revision: revisionReference(draft) };
    return signed ? signRowDecision(root, record) : record;
  });
}

/** Person-only atomic proposal disposition; a decline never replaces its target's approval. */
export function decideSpecRevisions(board, { agentId, channel, decisions }, { PERSON, atomic, rowDrafts, rowDecisions, recordRowDecisions, logEvent }) {
  if (agentId !== PERSON || !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_APPROVAL', 'only the person decides revisions through their terminal or view');
  if (!Array.isArray(decisions) || !decisions.length) throw new Refused('SPEC_REVISION', 'name a pending revision proposal');
  return atomic(board, () => {
    let drafts = rowDrafts(board);
    const seen = new Set();
    const targets = new Set();
    const pending = rowDecisions(board).filter(record => !record.applied);
    const planned = decisions.map(record => {
      const draft = drafts.find(entry => entry.id === record?.revision?.proposal);
      if (!draft || !validSpecRevision(draft) || draft.decision || draft.applied || seen.has(draft.id)
        || record.kind !== 'spec' || record.version !== 1 || record.type !== 'row-decision'
        || JSON.stringify(record.revision) !== JSON.stringify(revisionReference(draft))
        || record.id !== draft.revises || record.file !== draft.file || record.source !== draft.source
        || record.replacement !== draft.replacement || record.text !== draft.text
        || !['approve', 'decline'].includes(record.decision)
        || (record.decision === 'decline' && !String(record.reason ?? '').trim())) throw new Refused('SPEC_REVISION', 'the decision must match one undecided revision exactly; refresh Needs you');
      seen.add(draft.id);
      const target = JSON.stringify([draft.file, draft.revises]);
      if (record.decision === 'approve') {
        if (targets.has(target) || pending.some(current => current.kind === 'spec' && current.file === draft.file && current.id === draft.revises)) {
          throw new Refused('SPEC_REVISION', `${draft.revises} already has a pending approval or is named by two proposals; apply the first decision before approving another`);
        }
        targets.add(target);
      }
      return { record, draft };
    });
    const results = planned.map(({ record, draft }) => {
      const approved = record.decision === 'approve' ? recordRowDecisions(board, { agentId, channel, decisions: [record] })[0] : null;
      logEvent(board, PERSON, 'spec_revision_decision', null, { proposal: draft.id, record, channel });
      drafts = drafts.map(entry => entry.id === draft.id ? { ...entry, decision: record.decision,
        decisionEvent: approved?.event ?? board.lastEvent.event_id, decidedBy: PERSON, decidedAt: board.lastEvent.event_at } : entry);
      return approved ?? record;
    });
    board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(drafts), 'row_drafts');
    return results;
  });
}

/** Keep completed proposal history closed even after a newer target decision replaces its index entry. */
export function markAppliedRevisions(board, records, at, { rowDrafts }) {
  const ids = new Set(records.map(record => record.revision?.proposal).filter(Boolean));
  if (!ids.size) return;
  const drafts = rowDrafts(board).map(draft => ids.has(draft.id) ? { ...draft, applied: true, appliedAt: at } : draft);
  board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(drafts), 'row_drafts');
}

/** Expose both sides of each outstanding revision through the shared person projection. */
export function projectSpecRevisions(state, drafts, decisions) {
  const approvals = new Map(decisions.filter(record => record.decision === 'approve' && record.revision)
    .map(record => [record.revision.proposal, record]));
  const revisions = drafts.filter(draft => draft.revises && !draft.applied && draft.decision !== 'decline'
    && !approvals.get(draft.id)?.applied)
    .map(draft => ({ ...draft, ...(approvals.has(draft.id) ? { decision: 'approve', decisionEvent: approvals.get(draft.id).event } : {}),
      old: parseSpec(`## Revision\n${draft.source}\n`).rows[0],
      proposed: parseSpec(`## Revision\n${draft.replacement}\n`).rows[0] }));
  return { ...state, specRevisions: revisions };
}
