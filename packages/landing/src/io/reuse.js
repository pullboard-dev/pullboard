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
 * The paths that differ between two trees: [] for the same tree, null when either is missing or Git cannot say.
 *
 * @param {string | null | undefined} from
 * @param {string | null | undefined} to
 * @param {(from: string, to: string) => string[] | null} changedPaths
 * @returns {string[] | null}
 */
function movedPaths(from, to, changedPaths) {
  if (!from || !to) return null;
  if (from === to) return [];
  const paths = changedPaths(from, to);
  return Array.isArray(paths) ? paths : null;
}

/**
 * The closure judgement of a tiered landing: the merged tree may differ from the submit's tree only in paths main
 * changed since the submit's base (or the landing itself wrote), and the proof then answers for every candidate test
 * whose import closure none of the changed candidate or tooling paths reach. Why: a deferred proof read NOT_GREEN and a
 * moved main read BASE_MOVED, so every one-item batch ran a five-minute landing gate over tests the submit had already
 * proved on the same bytes [C7].
 *
 * @param {{ detail: any, proof: any, baseTree: string, base: string, tree: string, tooling: string | null,
 *   landed: Set<string>, treeOf: (rev: string) => string | null, changedPaths: (from: string, to: string) => string[] | null,
 *   closure: { candidates: () => string[], closureChanged: (file: string, changed: Set<string>) => boolean } }} input
 * @returns {{ code: string, rerun?: undefined } | { code?: undefined, rerun: string[] }}
 */
function closureRerun({ detail, proof, baseTree, base, tree, tooling, landed, treeOf, changedPaths, closure }) {
  const moved = movedPaths(baseTree, treeOf(base), changedPaths);
  if (moved === null) return { code: 'BASE_MOVED' };
  const allowed = new Set([...landed, ...moved]);
  const drift = movedPaths(detail.tree, tree, changedPaths);
  if (drift === null || !drift.every(path => allowed.has(path))) return { code: 'CANDIDATE_CHANGED' };
  const tools = movedPaths(detail.tooling, tooling, changedPaths);
  if (tools === null) return { code: 'TOOLING_CHANGED' };
  const changed = new Set([...drift, ...tools].filter(path => !landed.has(path)));
  const deferred = new Set(proof.deferredFiles ?? []);
  const rerun = [...new Set(closure.candidates())].filter(file => deferred.has(file) || (changed.size > 0 && closure.closureChanged(file, changed)));
  return { rerun: rerun.sort() };
}

/**
 * Whether one batch can land on its submit receipt: exactly one item, its submit green and complete, the composed
 * candidate tree equal to the tree the submit proved, the base tree equal to the tree of the main it composed on, the
 * tooling tree (RFC 0007 SC7, SC8) equal to the one the submit recorded, and the landing's selected plan no wider than
 * the plan the submit ran. Any mismatch returns a code and the gate runs; a receipt with no tooling tree is never reused.
 * A receipt whose known main failures are all main-owned cases of the item's green gate verdict (#3534) is green, and
 * the files of those cases count as proved: the frozen check ran them at submit [C7,#3685].
 * With `closure` (a tiered repository, whose tests reach what they import), the trees may instead differ by main's
 * commits since the submit, and a proof with deferred journeys is reused too: `rerun` lists only the candidates whose
 * import closure those commits reach, plus files the submit itself deferred [C7].
 * With `wholeSuite` (a landing that pushes), only a whole-suite receipt (proof.full) for the identical tree reuses [C7,#6271].
 *
 * @param {{ items: Array<{ id: number, commit: string }>, readEvents: (id: number) => object[], tree: string,
 *   base: string, tooling: string | null, full: boolean, wholeSuite?: boolean, files: string[], treeOf: (rev: string) => string | null,
 *   generated?: string[], changedPaths?: (from: string, to: string) => string[] | null,
 *   verdictOf?: (item: number, candidate: string) => object | null,
 *   closure?: { candidates: () => string[], closureChanged: (file: string, changed: Set<string>) => boolean } | null }} input
 * @returns {{ reuse: boolean, code: string | null, item?: number, commit?: string, tree?: string, rerun?: string[],
 *   mainOwned?: Array<{ file: string, name: string }> }}
 */
export function landingReceiptReuse({ items, readEvents, tree, base, tooling, full, wholeSuite = false, files, treeOf, generated = [], changedPaths = () => null, verdictOf, closure = null }) {
  // A landing that pushes (the default shape) reuses only a whole-suite receipt for the identical tree: no closure
  // drift, no batch of receipts, no plan narrower than the suite [C7,#6271].
  if (wholeSuite) { closure = null; full = true; }
  if (items.length !== 1 && !closure) return { reuse: false, code: 'BATCH_OF_MANY' };
  if (items.length !== 1) return batchReceiptReuse({ items, readEvents, tree, base, tooling, full, files, treeOf, generated, changedPaths, verdictOf, closure });
  const [entry] = items;
  const event = readEvents(entry.id).findLast(row => row.event_kind === 'submit');
  let detail;
  try { detail = event ? JSON.parse(event.event_detail) : null; } catch { detail = null; }
  const proof = detail?.submissionProof;
  // A submit admitted on main-owned reds records gateGreen false; the owned check below decides whether it proves [C7].
  if (!detail || detail.commit !== entry.commit || !(detail.gateGreen === true || detail.gateGreen === false && proof?.knownMainFailures) || !proof) return { reuse: false, code: 'NO_RECEIPT' };
  if ((proof.deferred && !closure) || detail.companion) return { reuse: false, code: 'NOT_GREEN' };
  const mainOwned = mainOwnedCases(verdictOf, entry.id, detail.commit);
  const owned = row => mainOwned?.some(cell => cell.file === row?.file && cell.name === row?.name);
  const known = proof.knownMainFailures;
  if (known && !(Array.isArray(known.failures) && known.failures.length && known.failures.every(owned))) return { reuse: false, code: 'NOT_GREEN' };
  const baseTree = detail.policyCommit ? treeOf(detail.policyCommit) : null;
  if (!detail.tree || !baseTree) return { reuse: false, code: 'NO_RECEIPT' };
  const landed = new Set(generated);
  const reused = { reuse: true, code: null, item: entry.id, commit: entry.commit, tree, ...(mainOwned?.length ? { mainOwned: mainOwned.map(({ file, name }) => ({ file, name })) } : {}) };
  if (closure) {
    const verdict = closureRerun({ detail, proof, baseTree, base, tree, tooling, landed, treeOf, changedPaths, closure });
    return verdict.code ? { reuse: false, code: verdict.code } : { ...reused, rerun: verdict.rerun };
  }
  // The same keyed comparison as the receipt cell's `reusable` (candidate tree, base tree, then tooling tree), kept local so landing adds no cross-cell edge.
  if (!sameTree(detail.tree, tree, landed, changedPaths)) return { reuse: false, code: 'CANDIDATE_CHANGED' };
  if (baseTree !== treeOf(base)) return { reuse: false, code: 'BASE_MOVED' };
  if (!tooling || !sameTree(detail.tooling, tooling, landed, changedPaths)) return { reuse: false, code: 'TOOLING_CHANGED' };
  const proved = new Set([...(proof.files ?? []), ...(mainOwned ?? []).map(cell => cell.file)]);
  if (full ? proof.full !== true : proof.full !== true && !files.every(file => proved.has(file))) return { reuse: false, code: 'PLAN_WIDER' };
  return reused;
}

/**
 * A batch of several items lands on their submit receipts together: each item's receipt must reuse as a one-item
 * batch would, with the other items' changed paths allowed in its drift, and the gate reruns the union of the items'
 * own reruns plus every candidate test whose import closure reaches the changes of two or more items. A test reaching
 * one item's change only runs the bytes that item's submit proved. Any item that cannot reuse refuses the batch's
 * reuse with its code, and the batch's plan runs as before.
 * Why: a batch of many reused nothing, so runners-only landing went one item at a time, six an hour (9 Nov) [C7].
 *
 * @param {Parameters<typeof landingReceiptReuse>[0]} input
 * @returns {ReturnType<typeof landingReceiptReuse>}
 */
function batchReceiptReuse({ items, readEvents, tree, base, tooling, treeOf, generated, changedPaths, verdictOf, closure }) {
  const own = new Map();
  for (const entry of items) {
    const event = readEvents(entry.id).findLast(row => row.event_kind === 'submit');
    let detail;
    try { detail = event ? JSON.parse(event.event_detail) : null; } catch { detail = null; }
    const baseTree = detail?.policyCommit ? treeOf(detail.policyCommit) : null;
    const paths = movedPaths(baseTree, detail?.tree, changedPaths);
    if (!paths) return { reuse: false, code: 'NO_RECEIPT', item: entry.id };
    own.set(entry.id, new Set(paths));
  }
  const rerun = new Set(), mainOwned = [];
  for (const entry of items) {
    // The other items' paths are theirs to prove, as the landing's own writes are; a test reaching both is an interaction.
    const others = new Set(items.filter(other => other.id !== entry.id).flatMap(other => [...own.get(other.id)]));
    const verdict = landingReceiptReuse({ items: [entry], readEvents, tree, base, tooling, full: false, files: [], treeOf,
      generated: [...generated, ...others], changedPaths, verdictOf, closure });
    if (!verdict.reuse) return { reuse: false, code: verdict.code, item: entry.id };
    for (const file of verdict.rerun ?? []) rerun.add(file);
    mainOwned.push(...(verdict.mainOwned ?? []));
  }
  for (const file of closure.candidates()) {
    const reached = items.filter(entry => closure.closureChanged(file, own.get(entry.id))).length;
    if (reached >= 2) rerun.add(file);
  }
  return { reuse: true, code: null, item: items[0].id, items: items.map(entry => entry.id), commit: items[0].commit, tree, rerun: [...rerun].sort(),
    ...(mainOwned.length ? { mainOwned } : {}) };
}

/**
 * The test files a green submit proof (deferred journeys or not) still answers for at the merged tree: each file the
 * submit ran whose own bytes and covered-package closure are unchanged. Why: landing reran the whole plan whenever the
 * proof carried deferred journeys, though only the journeys and the files whose closure moved need a run [C7,#3801].
 *
 * @param {{ proof: { files?: string[], deferredFiles?: string[] } | null | undefined,
 *   closureUnchanged: (file: string) => boolean }} input - closureUnchanged is true when the file and every package it covers match the submit
 * @returns {{ reuse: string[], rerun: string[] }} reuse lists proved files; rerun lists the submit's files that must run again
 */
export function reusableSubmitFiles({ proof, closureUnchanged }) {
  const deferred = new Set(proof?.deferredFiles ?? []);
  const reuse = [], rerun = [];
  for (const file of [...new Set(proof?.files ?? [])].sort()) {
    if (!deferred.has(file) && closureUnchanged(file)) reuse.push(file);
    else rerun.push(file);
  }
  return { reuse, rerun };
}
