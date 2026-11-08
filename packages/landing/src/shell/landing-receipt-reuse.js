/**
 * Landing reuses the submit gate's receipt instead of running the tests again [C7, RFC 0007].
 * Pure judgement over the batch's submit events and tree ids; the shell passes its git reads in as `treeOf`.
 */

/**
 * Whether one batch can land on its submit receipt: exactly one item, its submit green and complete, the composed
 * candidate tree equal to the tree the submit proved, the base tree equal to the tree of the main it composed on, the
 * tooling tree (RFC 0007 SC7, SC8) equal to the one the submit recorded, and the landing's selected plan no wider than
 * the plan the submit ran. Any mismatch returns a code and the gate runs; a receipt with no tooling tree is never reused.
 *
 * @param {{ items: Array<{ id: number, commit: string }>, readEvents: (id: number) => object[], tree: string,
 *   base: string, tooling: string | null, full: boolean, files: string[], treeOf: (rev: string) => string | null }} input
 * @returns {{ reuse: boolean, code: string | null, item?: number, commit?: string, tree?: string }}
 */
export function landingReceiptReuse({ items, readEvents, tree, base, tooling, full, files, treeOf }) {
  if (items.length !== 1) return { reuse: false, code: 'BATCH_OF_MANY' };
  const [entry] = items;
  const event = readEvents(entry.id).findLast(row => row.event_kind === 'submit');
  let detail;
  try { detail = event ? JSON.parse(event.event_detail) : null; } catch { detail = null; }
  const proof = detail?.submissionProof;
  if (!detail || detail.commit !== entry.commit || detail.gateGreen !== true || !proof) return { reuse: false, code: 'NO_RECEIPT' };
  if (proof.deferred || proof.knownMainFailures || detail.companion) return { reuse: false, code: 'NOT_GREEN' };
  const baseTree = detail.policyCommit ? treeOf(detail.policyCommit) : null;
  if (!detail.tree || !baseTree) return { reuse: false, code: 'NO_RECEIPT' };
  // The same keyed comparison as the receipt cell's `reusable` (candidate tree, base tree, then tooling tree), kept local so landing adds no cross-cell edge.
  if (detail.tree !== tree) return { reuse: false, code: 'CANDIDATE_CHANGED' };
  if (baseTree !== treeOf(base)) return { reuse: false, code: 'BASE_MOVED' };
  if (!tooling || detail.tooling !== tooling) return { reuse: false, code: 'TOOLING_CHANGED' };
  if (full ? proof.full !== true : proof.full !== true && !files.every(file => (proof.files ?? []).includes(file))) return { reuse: false, code: 'PLAN_WIDER' };
  return { reuse: true, code: null, item: entry.id, commit: entry.commit, tree };
}
