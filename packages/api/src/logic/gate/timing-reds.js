/**
 * The timing cases whose red on main may excuse a gate (#9754): each row names a test file (path without its extension)
 * and the start of a case name. Only the read-startup "clause 1" case is listed; its 200 ms bar is never touched here.
 */
export const TIMING_ROWS = Object.freeze([
  Object.freeze({ file: 'apps/cli/tests/io/commands/read-startup', namePrefix: 'clause 1' }),
]);

/** A test file path without its final extension, so a row names the file whichever suffix the runner reports. */
function stem(file) {
  return typeof file === 'string' ? file.replace(/(\.[a-z]+)+$/u, '') : file;
}

/** Whether a failing case sits in the timing row table. */
function inTimingRows(failure) {
  return TIMING_ROWS.some((row) => stem(failure?.file) === row.file && typeof failure?.name === 'string' && failure.name.startsWith(row.namePrefix));
}

/**
 * Whether a red on the gate and a red on main are the same timing red: both cases are in the timing row table and share
 * file and full name. The diagnostic signature is ignored on purpose: a timing red's message carries the measured
 * milliseconds, so its signature differs on every run and a signature match would never excuse it.
 */
export function sameTimingRed(gateCase, mainCase) {
  return inTimingRows(gateCase) && inTimingRows(mainCase) && stem(gateCase.file) === stem(mainCase.file) && gateCase.name === mainCase.name;
}
