/** Typed provenance of a proved Rigor row and the cause key grammar; prose alone never identifies a cause. No rigor-cell shell reads, so show reads it through the store's pure door [D1,S1,#7505]. */
import { RIGOR_NOTICE_ENGINE } from "../../../../../state/light.js";
export { RIGOR_NOTICE_ENGINE } from "../../../../../state/light.js";

/** The kinds of cause key and their shapes, in the order help and refusals name them. */
export const CAUSE_FORMS = Object.freeze(['test:<file>::<title>', 'refusal:<CODE>', 'row:<id>', 'doctrine:<id>', 'sentinel:<name>', 'conflict:<file>', 'instruction:<kind>']);

export const CAUSE = /^(?:test:(?<file>[^\s:][^\r\n:]*)::(?<title>\S[^\r\n]*)|refusal:(?<code>[A-Z][A-Z0-9_]*)|row:(?<row>[A-Z][A-Za-z0-9.]*)|doctrine:(?<doctrine>[A-Z][A-Za-z0-9.]*)|sentinel:(?<sentinel>[a-z0-9][a-z0-9._-]{0,63})|conflict:(?<conflict>[^\r\n\0]+)|instruction:(?:assignment|focus|freeze|merge-main|refreeze|routing))$/u;

/** Accept only typed evidence, never prose masquerading as a proof or a decided rule. */
export function readAutomaticRigorSource(source) {
  if (typeof source !== 'string' || !source.startsWith('rigor-auto:')) return null;
  try {
    const value = JSON.parse(decodeURIComponent(source.slice('rigor-auto:'.length)));
    if (value?.version !== 1 || value.unproved !== true || typeof value.key !== 'string' || !CAUSE.test(value.key) || value.key !== value.key.trim()
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

/** Keep the cause, evidence and executed proof in one row-safe, portable source field. */
export function rigorSource(cause, proof) {
  return 'rigor:' + encodeURIComponent(JSON.stringify({ version: 1, key: cause.key,
    evidence: { items: cause.items, occurrences: cause.occurrences, neverAgain: cause.neverAgain },
    proof: { check: proof.check, red: proof.red, green: proof.green } }));
}

/** Read only a typed, proved source; malformed fields and ordinary notes are not provenance. */
export function readRigorSource(source) {
  if (typeof source !== 'string' || !source.startsWith('rigor:')) return null;
  try {
    const data = JSON.parse(decodeURIComponent(source.slice(6)));
    const commit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
    if (data?.version !== 1 || typeof data.key !== 'string' || !CAUSE.test(data.key) || data.key !== data.key.trim()
      || !Array.isArray(data.evidence?.items) || !Number.isSafeInteger(data.evidence.occurrences) || data.evidence.occurrences < 0
      || typeof data.evidence.neverAgain !== 'boolean' || data.evidence.items.some(item => !Number.isSafeInteger(item?.id) || item.id < 1
        || !Array.isArray(item.commits) || item.commits.some(value => !commit(value)))
      || typeof data.proof?.check !== 'string' || !data.proof.check.trim()
      || !commit(data.proof.red?.commit) || !commit(data.proof.green?.commit)
      || !Number.isInteger(data.proof.red.exit) || !Number.isInteger(data.proof.green.exit)) return null;
    const work = data.key.startsWith('doctrine:') || data.key.startsWith('refusal:');
    if (work ? ![0, 1].includes(data.proof.red.exit) || ![0, 1].includes(data.proof.green.exit)
      || !(data.proof.red.problems > 0) || data.proof.green.problems !== 0
      : data.proof.red.exit === 0 || data.proof.green.exit !== 0) return null;
    return data;
  } catch { return null; }
}
