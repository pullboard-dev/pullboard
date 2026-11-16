/**
 * Keyed reuse of a submit receipt [C7]. Pure: a receipt is a value with the tree ids it proved, and these functions
 * only compare those ids. Tree ids, not commit ids, so a rebuilt or re-merged commit with the same content reuses.
 */
import { Refused } from '../../../kernel/light.js';

/**
 * The key a receipt is stored and read by: the candidate, base and tooling trees it was proved against (RFC 0007 SC7).
 *
 * Why: the tooling judges the run, so two runs on different tooling pins must never reuse each other's receipt.
 * Unpinned tooling is the candidate's own tree, which is what the gate runs then.
 *
 * @param {string} candidate - tree id of the candidate
 * @param {string} base - tree id of the base it was composed on
 * @param {string} [tooling] - tree id of the tooling pin; the candidate's own tree when none is pinned
 * @returns {string}
 */
export function receiptKey(candidate, base, tooling = candidate) {
  if (typeof candidate !== 'string' || !candidate || typeof base !== 'string' || !base) {
    throw new Refused('RECEIPT_KEY', 'a receipt key needs a candidate tree id and a base tree id; pass both.');
  }
  if (typeof tooling !== 'string' || !tooling) throw new Refused('RECEIPT_KEY', 'a receipt key needs a tooling tree id when one is given; pass the tooling pin tree.');
  return `${candidate}@${base}@${tooling}`;
}

/**
 * Whether a landing composition can reuse a submit receipt instead of running again. Only a green verdict proved
 * at exactly the composition's candidate, base and tooling trees is reusable; anything else must run.
 *
 * @param {{ candidate: string, base: string, tooling?: string, verdict: string } | null | undefined} receipt
 * @param {{ candidate: string, base: string, tooling?: string }} composition
 * @returns {{ reuse: boolean, code: string | null }}
 */
export function reusable(receipt, composition) {
  if (!receipt) return { reuse: false, code: 'NO_RECEIPT' };
  if (receipt.verdict !== 'green') return { reuse: false, code: 'NOT_GREEN' };
  if (receipt.candidate !== composition.candidate) return { reuse: false, code: 'CANDIDATE_CHANGED' };
  if (receipt.base !== composition.base) return { reuse: false, code: 'BASE_MOVED' };
  if ((receipt.tooling ?? receipt.candidate) !== (composition.tooling ?? composition.candidate)) return { reuse: false, code: 'TOOLING_CHANGED' };
  return { reuse: true, code: null };
}

/**
 * Read a receipt by key from a list or map of receipts; review and landing use this one lookup.
 *
 * @param {Iterable<{ candidate: string, base: string }> | Map<string, object>} receipts
 * @param {string} key
 * @returns {object | null}
 */
export function receiptByKey(receipts, key) {
  if (receipts instanceof Map) return receipts.get(key) ?? null;
  for (const receipt of receipts) if (receiptKey(receipt.candidate, receipt.base, receipt.tooling) === key) return receipt;
  return null;
}
