/** Typed provenance of a proved Rigor row; prose alone never identifies a cause [D1,S1]. */
import { causeProblem } from "../rigor.js";

import { RIGOR_NOTICE_ENGINE } from "../../../../../state/light.js";
export { RIGOR_NOTICE_ENGINE } from "../../../../../state/light.js";

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
    if (data?.version !== 1 || typeof data.key !== 'string' || causeProblem(data.key)
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
