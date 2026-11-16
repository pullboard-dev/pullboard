/** An item's runner cost sums its check-run runner minutes times each runner's rate, and is absent without a rate card [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemRunnerCost } from '../../../src/io/cost/runner.js';

const MINUTE = 60_000;
const BIG = 0.25;
const SMALL = 0.001;
const RECEIPTS = [
  { id: 'a', kind: 'check', runner: 'big', durationMs: 10 * MINUTE },
  { id: 'b', kind: 'check', runner: 'small', durationMs: 5 * MINUTE },
  { id: 'c', kind: 'check', runner: 'big', durationMs: 2 * MINUTE },
  { id: 'd', kind: 'verdict', runner: 'big', durationMs: 99 * MINUTE },
];

test('clause 1: an item cost is the sum of its check-run runner minutes times each runner cost per minute [C7]', () => {
  const { cost, perRunner } = itemRunnerCost(RECEIPTS, { big: BIG, small: SMALL });
  const expected = 12 * BIG + 5 * SMALL;
  assert.ok(Math.abs(cost - expected) < 1e-9, `${cost} vs ${expected}`);
  assert.ok(Math.abs(cost - 3.005) < 1e-9);
  assert.deepEqual(perRunner.map(row => [row.runner, row.minutes]), [['big', 12], ['small', 5]]);
});

test('clause 2: the runner cost is absent, never zero, when no rate card is set (no per-minute rate for any runner) [C7]', () => {
  assert.equal(itemRunnerCost(RECEIPTS, undefined).cost, null);
  assert.equal(itemRunnerCost(RECEIPTS, {}).cost, null);
  assert.equal(itemRunnerCost(RECEIPTS, { elsewhere: BIG }).cost, null);
  const partial = itemRunnerCost(RECEIPTS, { small: SMALL });
  assert.equal(partial.perRunner.find(row => row.runner === 'big').cost, null);
  assert.ok(partial.cost > 0);
});
