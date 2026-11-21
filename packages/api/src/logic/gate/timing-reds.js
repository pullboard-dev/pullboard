/**
 * The timing cases whose red on main may excuse a gate (#9754): each row names a test file (path without its extension)
 * and the start of a case name. Every case listed asserts a measured time against a budget: the read-startup "clause 1"
 * case, the store light door cold-load case, and the seat, release, cold state, submit, admission p95, write queue p99
 * and tour cases below. No bar is touched here.
 */
export const TIMING_ROWS = Object.freeze([
  Object.freeze({ file: 'apps/cli/tests/io/commands/read-startup', namePrefix: 'clause 1' }),
  Object.freeze({ file: 'packages/store/tests/io/light-load', namePrefix: 'store.io-light-load.' }),
  Object.freeze({ file: 'packages/items/tests/io/declaration/indexed', namePrefix: 'items.declaration.seat-family-indexed:' }),
  Object.freeze({ file: 'packages/items/tests/io/declaration/scope', namePrefix: 'items.declaration.seat-records-budget:' }),
  Object.freeze({ file: 'apps/cli/journeys/speed/release-median', namePrefix: 'cli.journeys-speed-release-median.' }),
  Object.freeze({ file: 'apps/cli/tests/io/commands/view/cold', namePrefix: 'cli.journeys-view-cold-state.a-cold-state-build-over-300-items-takes-under:' }),
  Object.freeze({ file: 'apps/cli/tests/io/submit/fast', namePrefix: 'cli.journeys-submit-fast.submit-on-a-clean-committed-item:' }),
  Object.freeze({ file: 'packages/gate/tests/io/main/admission-loans-p95-landing', namePrefix: 'p95 stays below twice standalone' }),
  Object.freeze({ file: 'packages/resources/tests/io/write/queue', namePrefix: 'resources.queue.at-1-000-simulated-seats-and:' }),
  Object.freeze({ file: 'apps/cli/tests/io/resume/tour', namePrefix: 'cli.journeys-resume-tour.the-tour-runs-a-reject-and:' }),
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
