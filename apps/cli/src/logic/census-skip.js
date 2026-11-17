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
