/** Which census files a later census could skip: green in the earlier one, with no declared input changed between the two shas [C7,#10379]. */

/**
 * Split a census's files into those that must run and those whose earlier green row could carry forward.
 *
 * @param {{ files: string[], previousRows: { file: string, status: string }[], selection: { full: boolean, reason?: string, files: string[] } }} input - `selection` is the affected-test selection between the two shas.
 * @returns {{ total: number, run: string[], skip: string[], share: number, full: boolean, reason: string }} `share` is the skipped fraction, 0 to 1.
 */
export function skipSplit({ files, previousRows, selection }) {
  const green = new Set(previousRows.filter(row => row.status === 'green').map(row => row.file));
  const named = new Set(selection.files);
  const skip = selection.full ? [] : files.filter(file => green.has(file) && !named.has(file));
  const kept = new Set(skip);
  const run = files.filter(file => !kept.has(file));
  return { total: files.length, run, skip, share: files.length ? skip.length / files.length : 0, full: selection.full === true, reason: selection.reason ?? '' };
}

/**
 * The rows a skipping census writes for the files it did not run: each earlier green row again, marked carried, with the
 * sha it was measured at. Why: the JSONL keeps one row per tracked file, so a reader of the census never has to know
 * which files were skipped [C7,#10383].
 *
 * @param {object[]} previousRows - The earlier census's rows.
 * @param {string[]} skip - Files to carry forward (from skipSplit).
 * @param {string} fromSha - The earlier census's sha.
 * @returns {object[]}
 */
export function carriedRows(previousRows, skip, fromSha) {
  const byFile = new Map(previousRows.map(row => [row.file, row]));
  return skip.flatMap(file => (byFile.has(file) ? [{ ...byFile.get(file), carried: true, carriedFrom: byFile.get(file).carriedFrom ?? fromSha }] : []));
}
