/**
 * The files that are quiet: their recent conflict rate is under the threshold [C7,#11084].
 *
 * A file with no recorded rate has never conflicted, so it is quiet. Why a pure filter: the caller
 * passes the rates from conflictRates and the queue.contentionThreshold setting, so this reads no board.
 *
 * @param {string[]} files - Candidate file paths.
 * @param {Map<string, number>} rates - Conflict count per file over the recent window.
 * @param {number} threshold - A file at or over this rate is not quiet.
 * @returns {string[]} The quiet files, in the order given.
 */
export function quietFiles(files, rates, threshold) {
  return files.filter(file => (rates.get(file) ?? 0) < threshold);
}
