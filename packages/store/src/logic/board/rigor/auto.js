/** Evidence-only proposals are deliberately distinct from executed rigor: proofs [D1,S1]. */
import { parseSpec } from "../../../../../spec/index.js";
import { Refused } from "../../../../../kernel/light.js";
import { readRigorSource } from "./provenance.js";
import { automaticSourceFromText } from "./provenance.js";
import { readAutomaticRigorSource } from "./provenance.js";
export { automaticSourceFromText, readableRigorText, readAutomaticRigorSource } from "./provenance.js";
import {
  rowDecisionContext,
  staleRowDecision,
} from "../../../../../spec/index.js";

/** Preserve exact repeat evidence in a portable one-line ordinary draft. */
export function automaticRigorSource(cause, eventIds) {
  return 'rigor-auto:' + encodeURIComponent(JSON.stringify({ version: 1, unproved: true, key: cause.key,
    evidence: { items: cause.items, occurrences: cause.occurrences, neverAgain: cause.neverAgain ?? false,
      events: [...new Set(eventIds)] } }));
}

/** The exact automatic source captured in a person's existing file-backed row decision. */
export function automaticDecisionSource(record) {
  try {
    const rows = parseSpec(`## Decision\n${record.source ?? ''}\n`).rows;
    return rows.length === 1 ? automaticSourceFromText(rows[0].text) : null;
  } catch (error) {
    if (error instanceof Refused && error.code === 'A5_GRAMMAR_VERSION') return null;
    throw error;
  }
}

/** A proved replacement decision also answers older unproved advice about that same cause. */
export function rigorDecisionKey(record) {
  try {
    const rows = parseSpec(`## Decision\n${record.source ?? ''}\n`).rows;
    return rows.length === 1 ? readRigorSource(rows[0].source)?.key
      ?? readAutomaticRigorSource(automaticSourceFromText(rows[0].text))?.key ?? null : null;
  } catch (error) {
    if (error instanceof Refused && error.code === 'A5_GRAMMAR_VERSION') return null;
    throw error;
  }
}

/** A materialized row must preserve the whole definition; merely occupying its id is a collision. */
export function sameAutomaticRow(row, draft) {
  const expected = { id: draft.id, status: 'draft', tier: draft.tier, text: draft.text, gate: draft.gate,
    serves: [], signers: [], unknown: [] };
  return expected && ['id', 'status', 'tier', 'text', 'gate', 'serves', 'signers', 'unknown', 'count', 'runs', 'mode', 'files', 'source']
    .every(key => JSON.stringify(row[key]) === JSON.stringify(expected[key]));
}

/** Show board-only drafts immediately, and keep mismatching file occupants visible until resolved. */
export function automaticRigorNeeds(state, drafts = [], decisions = []) {
  const rows = [...(state.spec ?? []).map(row => ({ ...row, target: 'spec' })),
    ...(state.practice ?? []).filter(row => row.origin !== 'standard').map(row => ({ ...row, target: 'doctrine' }))];
  const candidates = [...drafts.filter(draft => automaticSourceFromText(draft.text)),
    ...rows.filter(row => automaticSourceFromText(row.text) && !drafts.some(draft => draft.id === row.id && draft.target === row.target))];
  if (!candidates.length) return [];
  const context = state.root && decisions.length ? rowDecisionContext(state.root) : null;
  return candidates.flatMap(draft => {
    const source = automaticSourceFromText(draft.text);
    const parsed = readAutomaticRigorSource(source);
    if (rows.some(row => ['draft', 'pending', 'approved'].includes(row.status) && row.decision?.decision !== 'decline'
      && readRigorSource(row.source)?.key === parsed.key)) return [];
    const decided = decisions.some(record => context && !staleRowDecision(record, context)
      && (record.id === draft.id && record.kind === draft.target && automaticDecisionSource(record) === source
        || record.kind === draft.target && record.event > (draft.event ?? Infinity) && rigorDecisionKey(record) === parsed.key));
    const found = rows.filter(row => row.id === draft.id);
    const exact = found.length === 1 && found[0].target === draft.target && sameAutomaticRow(found[0], draft);
    if (decided || exact && found[0].decision) return [];
    const collision = found.length > 0 && !exact;
    return [{ kind: 'rigor-draft', id: `${draft.target}:${draft.id}`, ref: draft.target === 'doctrine' ? `doctrine:${draft.id}` : draft.id,
      target: `${draft.target}:${draft.id}`, text: `Rigor draft (unproved): ${draft.text.slice(0, draft.text.lastIndexOf(' Source: '))}`, cause: parsed.key,
      evidence: parsed.evidence, proof: null, unproved: true, materialized: exact, collision,
      what: collision ? 'Coordinator: resolve the row id collision before materializing this proposal'
        : exact ? 'Approve or Decline this unproved proposal' : 'Coordinator: materialize with pullboard spec apply; then the person approves or declines' }];
  });
}
