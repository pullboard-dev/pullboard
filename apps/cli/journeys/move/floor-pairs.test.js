/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js */
/** Pair floor check 1/3: claim, editItem, finishLandingBatch and holdItem take the larger floor of any two options [C7,V4,H16,#9670]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTOMATIC_DISPATCH_ENGINE,
  BAR_ENGINE,
  BOARD_SENTINEL_ENGINE,
  CHECK_TIMING_ENGINE,
  CROSS_REPO_DEPENDENCY_ENGINE,
  EXIT_RULES_ENGINE,
  EXPECTED_BUILD_ENGINE,
  ITEM_FOLDER_ENGINE,
  LANDING_LEASE_ENGINE,
  LINE_CAPACITY_ENGINE,
  MACHINE_VERDICT_ENGINE,
  PER_ITEM_FULL_SUITE_ENGINE,
  PIPELINE_CAUSE_ENGINE,
  READINESS_ENGINE,
  REFERENCE_ENGINE,
  REJECTION_RETURN_ENGINE,
  REVIEW_INDEPENDENCE_ENGINE,
  REVIEW_TIER_ENGINE,
  REWORK_SAME_FAMILY_ENGINE,
  RIGOR_AUTO_ENGINE,
  STALE_STATE_ENGINE,
  SUBMIT_ADMISSION_ENGINE,
} from '../../../../packages/state/light.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import {
  floorAloneProblems,
  floorPairProblems,
} from '../../tests/fixtures/move/registry/floor-pairs.js';

const CONFLICT = { name: 'cause conflict', args: [1, { cause: 'conflict:x' }], floor: RIGOR_AUTO_ENGINE, group: 'cause' };
const SENTINEL = { name: 'cause sentinel', args: [1, { cause: 'sentinel:x' }], floor: BOARD_SENTINEL_ENGINE, group: 'cause' };

/**
 * One table per move: every feature option that raises its floor, with the floor the option alone yields. An option
 * marked `board` reads board state, so it is listed but only checked with a board (the registry test covers those).
 * The allow-list names the pairs that fail today; later slices fix them and shrink it, and it never grows.
 */
const TABLES = [
  { move: 'claim', options: [
    { name: 'buildBudgetMinutes', args: [1, { buildBudgetMinutes: 30 }], floor: EXPECTED_BUILD_ENGINE },
    { name: 'returnRejectedWork', args: [1, { returnRejectedWork: true }], floor: REJECTION_RETURN_ENGINE },
    { name: 'submitOutcome', args: [1, { submitOutcome: 'red' }], floor: PIPELINE_CAUSE_ENGINE },
    { name: 'exitRules', args: [1, { exitRules: { enabled: true } }], floor: EXIT_RULES_ENGINE },
    { name: 'reworkSameFamily', args: [1, { reworkSameFamily: true }], floor: REWORK_SAME_FAMILY_ENGINE },
    { name: 'itemFolder', args: [1, { itemFolder: true }], floor: ITEM_FOLDER_ENGINE },
    { name: 'adoptCorrection', args: [1, { adoptCorrection: true }], floor: AUTOMATIC_DISPATCH_ENGINE },
    { name: 'submitAdmission', args: [1, { submitAdmission: {} }], floor: SUBMIT_ADMISSION_ENGINE },
    { name: 'lineCapacity', args: [1, { lineCapacity: true }], floor: LINE_CAPACITY_ENGINE },
    CONFLICT,
    SENTINEL,
    { name: 'checkTiming (item check timing)', board: 'item_check_timing meta', args: [1], floor: CHECK_TIMING_ENGINE },
    { name: 'bar ready setting', board: 'bar-ready setting on', args: [1], floor: 96 },
    { name: 'reopen first refusal', board: 'a first refusal on the item', args: [1], floor: 66 },
    { name: 'foreign dependency', board: 'item_after names another repo', args: [1], floor: CROSS_REPO_DEPENDENCY_ENGINE },
    { name: 'outside source', board: 'item came from outside intake', args: [1], floor: 97 },
  ] },
  { move: 'editItem', options: [
    { name: 'machineVerified', args: [1, { machineVerified: true }], floor: MACHINE_VERDICT_ENGINE },
    { name: 'expectedBuildMinutes', args: [1, { expectedBuildMinutes: 30 }], floor: EXPECTED_BUILD_ENGINE },
    { name: 'readinessCommand', args: [1, { readinessCommand: 'true' }], floor: READINESS_ENGINE },
    { name: 'checkTiming', args: [1, { checkTiming: {} }], floor: CHECK_TIMING_ENGINE },
    { name: 'reviewTier', args: [1, { reviewTier: 'standard' }], floor: REVIEW_TIER_ENGINE },
    { name: 'sensitive', args: [1, { sensitive: true }], floor: REVIEW_INDEPENDENCE_ENGINE },
    { name: 'referenceAuthors', args: [1, { referenceAuthors: [] }], floor: REFERENCE_ENGINE },
    { name: 'reviewFamily', args: [1, { reviewFamily: 'anthropic' }], floor: AUTOMATIC_DISPATCH_ENGINE },
    { name: 'preserveFrozen', args: [1, { preserveFrozen: true }], floor: PER_ITEM_FULL_SUITE_ENGINE },
    { name: 'bar reason', args: [1, { reason: 'bar corrected' }], floor: BAR_ENGINE },
    { name: 'after (local)', args: [1, { after: [2] }], floor: 10, group: 'after' },
    { name: 'after (foreign)', args: [1, { after: ['other#3'] }], floor: CROSS_REPO_DEPENDENCY_ENGINE, group: 'after' },
    CONFLICT,
    SENTINEL,
    { name: 'blocked release wait', board: 'blocked_release_waiting meta', args: [1], floor: 197 },
    { name: 'bar ready setting', board: 'bar-ready setting on', args: [1], floor: 96 },
  ] },
  { move: 'finishLandingBatch', options: [
    { name: 'landingFence', args: [{ id: 1, landingFence: 1 }], floor: LANDING_LEASE_ENGINE },
    { name: 'cause conflict', args: [{ id: 1 }, { cause: 'conflict:x' }], floor: RIGOR_AUTO_ENGINE, group: 'cause' },
    { name: 'cause sentinel', args: [{ id: 1 }, { cause: 'sentinel:x' }], floor: BOARD_SENTINEL_ENGINE, group: 'cause' },
    { name: 'external batch', board: 'a landing batch marked external', args: [{ id: 1 }], floor: 249 },
    { name: 'flake ratchet batch', board: 'a landing batch with a flake ratchet', args: [{ id: 1 }], floor: 212 },
    { name: 'quarantined gate batch', board: 'a landing batch with a quarantined gate', args: [{ id: 1 }], floor: 176 },
    { name: 'landing environment', board: 'a landing batch with an environment defect', args: [{ id: 1 }], floor: 85 },
  ] },
  { move: 'holdItem', options: [
    { name: 'until', args: [1, { until: 'verified' }], floor: STALE_STATE_ENGINE },
    CONFLICT,
    SENTINEL,
  ] },
];

/** The pairs that fail today, by table: empty means every checked pair already takes the larger floor. */
const ALLOW_LIST = new Map([
  ['claim', []],
  ['editItem', []],
  ['finishLandingBatch', []],
  ['holdItem', []],
]);

test('clause 1: floorPairProblems reports a toy move whose combined options yield less than the larger floor and none for a correct one [C7,V4]', () => {
  const first = { name: 'a', args: [1, { a: true }], floor: 10 };
  const second = { name: 'b', args: [1, { b: true }], floor: 20 };
  // The toy answers like a first-match chain (the first option wins): the pair yields 10, below 20.
  const toy = (args) => (args[1].a ? 10 : args[1].b ? 20 : 1);
  const registry = (answer) => (move, args) => { assert.equal(move, 'toy'); return answer(args); };
  const wrongPairs = floorPairProblems({ move: 'toy', options: [first, second] }, registry(toy));
  assert.deepEqual(wrongPairs, ['toy: a + b yields 10, below the larger floor 20']);
  const correct = (args) => Math.max(args[1].a ? 10 : 1, args[1].b ? 20 : 1);
  assert.deepEqual(floorPairProblems({ move: 'toy', options: [first, second] }, registry(correct)), []);
  assert.deepEqual(floorPairProblems({ move: 'toy', options: [{ ...first, group: 'g' }, { ...second, group: 'g' }] }, registry(toy)), [], 'options of one group never combine');
});

test('clause 2: every option of claim, editItem, finishLandingBatch and holdItem is listed with its floor, and each pair that fails today is on the allow-list [C7,V4,H16]', () => {
  assert.deepEqual(TABLES.map(table => table.move), ['claim', 'editItem', 'finishLandingBatch', 'holdItem']);
  for (const table of TABLES) {
    assert.ok(table.options.length >= 3, `${table.move} lists its options`);
    for (const option of table.options) {
      assert.ok(Number.isSafeInteger(option.floor) && option.floor > 1, `${table.move}: ${option.name} lists a floor above 1`);
    }
    assert.deepEqual(floorAloneProblems(table), [], `${table.move}: each listed floor is what the option yields alone`);
    const allowed = ALLOW_LIST.get(table.move);
    assert.ok(Array.isArray(allowed), `${table.move} has an allow-list entry`);
    const failing = floorPairProblems(table);
    assert.deepEqual(failing.filter(line => !allowed.some(name => line.startsWith(`${table.move}: ${name} `))), [], `${table.move}: pairs below the larger floor that the allow-list does not name`);
    for (const name of allowed) assert.ok(failing.some(line => line.startsWith(`${table.move}: ${name} `)), `${table.move}: the allow-list names ${name}, which now passes; remove it`);
  }
  assert.ok(minimumMoveEngine, 'the registry answers floors');
});
