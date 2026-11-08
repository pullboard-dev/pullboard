/**
 * Landing reuses the submit gate's receipt instead of running the tests again [C7, RFC 0007].
 * Pure judgement over the batch's submit events and tree ids; the shell passes its git and board reads in as ports.
 */

/**
 * Whether a recorded tree answers for the current one: the same tree, or one that differs only in paths the landing
 * itself wrote after the merge (badge counts, lowered doctrine counts). Why: those writes are board-derived data, so
 * comparing whole trees made every landing read CANDIDATE_CHANGED and no receipt was ever reused [C7,#3685].
 *
 * @param {string | null | undefined} recorded
 * @param {string | null | undefined} current
 * @param {Set<string>} generated - the paths the landing wrote
 * @param {(from: string, to: string) => string[] | null} changedPaths
 * @returns {boolean}
 */
function sameTree(recorded, current, generated, changedPaths) {
  if (!recorded || !current) return false;
  if (recorded === current) return true;
  if (!generated.size) return false;
  const paths = changedPaths(recorded, current);
  return Array.isArray(paths) && paths.length > 0 && paths.every(path => generated.has(path));
}

/**
 * The main-owned cases a green gate verdict (#3534) recorded for this submit, or null when there is none. Why: a submit
 * whose only reds main owns records green with them listed, so landing reads that verdict, not the red receipt.
 *
 * @param {((item: number, candidate: string) => object | null) | undefined} verdictOf
 * @param {number} item
 * @param {string} commit
 * @returns {Array<{ file: string, name: string }> | null}
 */
function mainOwnedCases(verdictOf, item, commit) {
  const verdict = verdictOf?.(item, commit) ?? null;
  return verdict?.green === true && Array.isArray(verdict.mainOwned) ? verdict.mainOwned : null;
}

/**
 * Whether one batch can land on its submit receipt: exactly one item, its submit green and complete, the composed
 * candidate tree equal to the tree the submit proved, the base tree equal to the tree of the main it composed on, the
 * tooling tree (RFC 0007 SC7, SC8) equal to the one the submit recorded, and the landing's selected plan no wider than
 * the plan the submit ran. Any mismatch returns a code and the gate runs; a receipt with no tooling tree is never reused.
 * A receipt whose known main failures are all main-owned cases of the item's green gate verdict (#3534) is green, and
 * the files of those cases count as proved: the frozen check ran them at submit [C7,#3685].
 *
 * @param {{ items: Array<{ id: number, commit: string }>, readEvents: (id: number) => object[], tree: string,
 *   base: string, tooling: string | null, full: boolean, files: string[], treeOf: (rev: string) => string | null,
 *   generated?: string[], changedPaths?: (from: string, to: string) => string[] | null,
 *   verdictOf?: (item: number, candidate: string) => object | null }} input
 * @returns {{ reuse: boolean, code: string | null, item?: number, commit?: string, tree?: string,
 *   mainOwned?: Array<{ file: string, name: string }> }}
 */
export function landingReceiptReuse({ items, readEvents, tree, base, tooling, full, files, treeOf, generated = [], changedPaths = () => null, verdictOf }) {
  if (items.length !== 1) return { reuse: false, code: 'BATCH_OF_MANY' };
  const [entry] = items;
  const event = readEvents(entry.id).findLast(row => row.event_kind === 'submit');
  let detail;
  try { detail = event ? JSON.parse(event.event_detail) : null; } catch { detail = null; }
  const proof = detail?.submissionProof;
  if (!detail || detail.commit !== entry.commit || detail.gateGreen !== true || !proof) return { reuse: false, code: 'NO_RECEIPT' };
  if (proof.deferred || detail.companion) return { reuse: false, code: 'NOT_GREEN' };
  const mainOwned = mainOwnedCases(verdictOf, entry.id, detail.commit);
  const owned = row => mainOwned?.some(cell => cell.file === row?.file && cell.name === row?.name);
  const known = proof.knownMainFailures;
  if (known && !(Array.isArray(known.failures) && known.failures.length && known.failures.every(owned))) return { reuse: false, code: 'NOT_GREEN' };
  const baseTree = detail.policyCommit ? treeOf(detail.policyCommit) : null;
  if (!detail.tree || !baseTree) return { reuse: false, code: 'NO_RECEIPT' };
  const landed = new Set(generated);
  // The same keyed comparison as the receipt cell's `reusable` (candidate tree, base tree, then tooling tree), kept local so landing adds no cross-cell edge.
  if (!sameTree(detail.tree, tree, landed, changedPaths)) return { reuse: false, code: 'CANDIDATE_CHANGED' };
  if (baseTree !== treeOf(base)) return { reuse: false, code: 'BASE_MOVED' };
  if (!tooling || !sameTree(detail.tooling, tooling, landed, changedPaths)) return { reuse: false, code: 'TOOLING_CHANGED' };
  const proved = new Set([...(proof.files ?? []), ...(mainOwned ?? []).map(cell => cell.file)]);
  if (full ? proof.full !== true : proof.full !== true && !files.every(file => proved.has(file))) return { reuse: false, code: 'PLAN_WIDER' };
  return { reuse: true, code: null, item: entry.id, commit: entry.commit, tree, ...(mainOwned?.length ? { mainOwned: mainOwned.map(({ file, name }) => ({ file, name })) } : {}) };
}
