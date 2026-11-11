/**
 * Submit's main-red acceptance for the proof run: a neighbouring case base main also fails passes by name [C7].
 *
 * Why: an item whose own check was green still got a red gate when the proof reached a test file holding a case red on
 * main, and a red case's details (checkout paths, timings) rarely match main's exactly, so builders released green work
 * (#2437, #1543, #1829, #2539). A case the item's criterion or check names is the item's own and keeps the exact
 * failure signature; any other case passes when base main fails that same file and case by name with the same assertion
 * (the stable signature and asserted values, else the first error line), since a changed assertion under a shared title
 * is the item's regression, not main's red [C7,V4,B3,H16]. Cases sharing a title cannot be matched by name, so they refuse.
 */
import { matchingMainFailures } from '../../../../../packages/landing/index.js';

/** The test file paths a check command names, without a leading ./ */
function checkFiles(check) {
  return String(check ?? '').split(/\s+/u).map(word => word.replace(/^['"]|['"]$/gu, '').replace(/^\.\//u, ''))
    .filter(word => /\.[cm]?js$/u.test(word));
}

/**
 * Whether a failing case belongs to the item's own bar: its file is one the check runs, or the criterion names its file
 * or its case.
 *
 * @param {{ file: string, name: string }} failure
 * @param {{ criterion?: string, check?: string }} bar
 */
export function ownCase(failure, { criterion = '', check = '' } = {}) {
  const text = String(criterion);
  return checkFiles(check).includes(failure.file) || (failure.file && text.includes(failure.file)) || (failure.name && text.includes(failure.name));
}

/**
 * Whether a proof failure shows main's own assertion: the stable signature with its asserted values when both carry
 * one, else the first error line. A failure with neither is unproven, so it never passes by name alone.
 */
function sameAssertion(failure, comparison) {
  const file = comparison.files.find(row => row.file === failure.file);
  const main = file?.failures?.find(row => row.file === failure.file && row.name === failure.name);
  if (!main) return false;
  if (failure.stable && main.stable) return failure.stable === main.stable && failure.stableData === main.stableData;
  return Boolean(failure.firstError) && failure.firstError === main.firstError;
}

/**
 * Whether any proof failure is a case base main fails with another assertion (both carry comparable details that
 * differ): the item's regression under a shared title, which no repair item's name-only baseline may excuse [V4,C7].
 */
export function regressesMain(failures, comparison) {
  return (failures ?? []).some(failure => {
    const main = comparison?.files?.find(row => row.file === failure.file)?.failures?.find(row => row.file === failure.file && row.name === failure.name);
    if (!main) return false;
    if (failure.stable && main.stable) return failure.stable !== main.stable || failure.stableData !== main.stableData;
    return Boolean(failure.firstError && main.firstError) && failure.firstError !== main.firstError;
  });
}

/**
 * Match every proof failure against base main: own cases by exact signature, neighbouring cases by file and case name.
 * Returns `{ main, failures }` when every failure is accounted for, else null, as matchingMainFailures does.
 *
 * @param {{ file: string, name: string, signature?: string }[]} failures
 * @param {object} comparison The base-main comparison.
 * @param {string} main The base main commit.
 * @param {{ criterion?: string, check?: string }} bar The item's frozen criterion and check.
 */
export function proofMainFailures(failures, comparison, main, bar) {
  if (!failures?.length) return null;
  if (new Set(failures.map(failure => failure.name)).size !== failures.length) return null;
  const own = failures.filter(failure => ownCase(failure, bar));
  const neighbours = failures.filter(failure => !ownCase(failure, bar));
  const exact = own.length ? matchingMainFailures(own, comparison, main) : { main, failures: [] };
  const named = neighbours.length ? matchingMainFailures(neighbours, comparison, main, { byCase: true }) : { main, failures: [] };
  if (named && !neighbours.every(failure => sameAssertion(failure, comparison))) return null;
  return exact && named ? { main, failures } : null;
}

/**
 * Whether base main fails every one of these gate failures by file and case name, so a red gate made only of them is
 * main's red and no sign the item's code is looping [C7].
 *
 * @param {{ file: string, name: string }[]} failures - The cases one red gate recorded.
 * @param {object} comparison - What is known of main's failures in those files.
 * @param {string} main - The main commit the comparison was taken at.
 */
export function redsAreMains(failures, comparison, main) {
  return Boolean(failures?.length) && matchingMainFailures(failures, comparison, main, { byCase: true }) !== null;
}
