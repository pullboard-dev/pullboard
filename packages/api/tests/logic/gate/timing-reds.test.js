/** @pullboard-test-input source-cell api */
/** sameTimingRed excuses only a timing-table case that fails on both gate and main under one name [C7,#9754]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameTimingRed } from '../../../src/logic/gate/timing-reds.js';

const FILE = 'apps/cli/tests/io/commands/read-startup.test.js';
const NAME = 'clause 1: read startup stays under 200 ms';

test('api.gate-timing-reds.sametimingred-true-read-startup-clause: clause 1: sameTimingRed is true for read-startup clause 1 failing on gate and main with different measured numbers [C7,#9754]', () => {
  const gate = { file: FILE, name: NAME, message: 'startup took 423 ms', signature: 'a' };
  const main = { file: FILE, name: NAME, message: 'startup took 182 ms', signature: 'b' };
  assert.equal(sameTimingRed(gate, main), true);
});

test('api.gate-timing-reds.sametimingred-false-case-outside-timing: clause 2: sameTimingRed is false for a case outside the timing row table [C7,#9754]', () => {
  const other = { file: 'packages/api/tests/claim.test.js', name: 'clause 1: claims' };
  assert.equal(sameTimingRed(other, other), false);
  const sameFileOtherCase = { file: FILE, name: 'clause 2: something else' };
  assert.equal(sameTimingRed(sameFileOtherCase, sameFileOtherCase), false);
});

test('api.gate-timing-reds.sametimingred-false-when-two-case: clause 3: sameTimingRed is false when the two case names differ [C7,#9754]', () => {
  const gate = { file: FILE, name: NAME };
  const main = { file: FILE, name: 'clause 1: another wording' };
  assert.equal(sameTimingRed(gate, main), false);
});

test('api.gate-timing-reds.sametimingred-true-store-light-load: clause 4: sameTimingRed is true for the store light-door cold-load case failing on gate and main under one name, and false for another case of that file [C7,#11815]', () => {
  const file = 'packages/store/tests/io/light-load.test.js';
  const name = 'store.io-light-load.packages-store-light-js-loads-cold: clause 2: packages/store/light.js loads cold in under 100 ms of module work [C7]';
  assert.equal(sameTimingRed({ file, name, signature: 'a' }, { file, name, signature: 'b' }), true);
  const other = { file, name: 'store.io-other.something: clause 1: something else' };
  assert.equal(sameTimingRed(other, other), false);
});

const MAIN_TIMING_CASES = [
  ['packages/items/tests/io/declaration/indexed.test.js', 'items.declaration.seat-family-indexed: seatFamily plans no board_meta scan and 1,000 calls finish under 50 ms on 300,000 rows [C7,#2976]'],
  ['packages/items/tests/io/declaration/scope.test.js', 'items.declaration.seat-records-budget: clause 1: inbox, status and heartbeat on a board with 1,900 agent rows spend under 100 ms in seatRecords [C7,#3251]'],
  ['apps/cli/tests/io/commands/release/median.test.js', 'cli.journeys-speed-release-median.the-release-median-on-the-2: clause 1: [C7] the release median on the 2,500-item board is held under its budget, in-process'],
  ['apps/cli/journeys/view/cold-state.test.js', 'cli.journeys-view-cold-state.a-cold-state-build-over-300-items-takes-under: clause 1: a cold state build over 300 items takes under 10 s [C7,#8480]'],
  ['apps/cli/tests/io/submit/fast.test.js', 'cli.journeys-submit-fast.submit-on-a-clean-committed-item: clause 1: submit on a clean committed item returns within 5 seconds [C7]'],
  ['packages/gate/tests/io/main/admission-loans-p95-landing.test.js', 'p95 stays below twice standalone'],
  ['packages/resources/tests/io/write/queue.test.js', 'resources.queue.at-1-000-simulated-seats-and: clause 2: at 1,000 simulated seats the slot take and release return within 50 ms at p99 [C7,#3084]'],
  ['apps/cli/journeys/resume/tour.test.js', 'cli.journeys-resume-tour.the-tour-runs-a-reject-and: the tour runs a reject and its rework on a throwaway repo, in under thirty seconds [N10]'],
];

test('api.gate-timing-reds.sametimingred-true-main-timing-cases: clause 5: sameTimingRed is true for each timing-only case red on main failing on gate and main under one name, and false for another case of that file [C7]', () => {
  for (const [file, name] of MAIN_TIMING_CASES) {
    assert.equal(sameTimingRed({ file, name, signature: 'a' }, { file, name, signature: 'b' }), true, `${file} ${name}`);
    const other = { file, name: 'a case outside the timing row' };
    assert.equal(sameTimingRed(other, other), false, `${file} other case`);
  }
});
