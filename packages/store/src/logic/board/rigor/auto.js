/** Evidence-only proposals are deliberately distinct from executed rigor: proofs [D1,S1]. */
import { causeProblem } from "../rigor.js";
import { parseSpec } from "../../../../../spec/index.js";
import { Refused } from "../../../../../kernel/light.js";
import { readRigorSource } from "./provenance.js";
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

/** Accept only typed evidence, never prose masquerading as a proof or a decided rule. */
export function readAutomaticRigorSource(source) {
  if (typeof source !== 'string' || !source.startsWith('rigor-auto:')) return null;
  try {
    const value = JSON.parse(decodeURIComponent(source.slice('rigor-auto:'.length)));
    if (value?.version !== 1 || value.unproved !== true || typeof value.key !== 'string' || causeProblem(value.key)
      || !Array.isArray(value.evidence?.items) || !Number.isSafeInteger(value.evidence.occurrences) || value.evidence.occurrences < 0
      || value.evidence.occurrences === 0 && value.evidence.neverAgain !== true
      || typeof value.evidence.neverAgain !== 'boolean' || !Array.isArray(value.evidence.events) || !value.evidence.events.length
      || value.evidence.events.some(id => !Number.isSafeInteger(id) || id < 1)
      || value.evidence.items.some(item => !Number.isSafeInteger(item?.id) || item.id < 1 || !Array.isArray(item.commits)
        || item.commits.some(commit => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)))) return null;
    return value;
  } catch { return null; /* Malformed historical metadata cannot establish a proposal. */ }
}

/** Read the complete terminal typed source without inferring identity from the surrounding advice. */
export function automaticSourceFromText(text) {
  const source = /(?:^| )Source: (rigor-auto:\S+)$/u.exec(text ?? '')?.[1];
  return readAutomaticRigorSource(source) ? source : null;
}

/** Row text for display: a trailing rigor-auto source becomes one readable line, all other text is unchanged. */
export function readableRigorText(text) {
  const source = automaticSourceFromText(text);
  if (!source) return text;
  const { key, evidence } = readAutomaticRigorSource(source);
  const ids = evidence.items.map(item => `#${item.id}`).join(', ');
  const count = `${evidence.occurrences} occurrence${evidence.occurrences === 1 ? '' : 's'}`;
  return `${text.slice(0, text.length - source.length - ' Source: '.length)} Source: Rigor evidence for ${key}, ${count}${ids ? ` across ${ids}` : ''}.`;
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
