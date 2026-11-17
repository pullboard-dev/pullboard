/** Split or bisect is arithmetic on the batch's own gate: a pair splits, four or more bisect at today's fixed share [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redBatchCosts } from '../../index.js';
import { splitBeatsBisect } from '../../index.js';

test('landing.split.with-half-the-gate-fixed-and: clause 1: with half the gate fixed and a small focus, a pair splits and four bisect [C7]', () => {
  const pair = splitBeatsBisect({ items: 2, gateMs: 8 * 60_000 });
  assert.equal(pair.split, true, `pair: split ${pair.splitMs} vs bisect ${pair.bisectMs}`);
  const four = splitBeatsBisect({ items: 4, gateMs: 8 * 60_000 });
  assert.equal(four.split, false, `four: split ${four.splitMs} vs bisect ${four.bisectMs}`);
  assert.equal(four.levels, 2);
});

test('landing.split.the-costs-follow-the-measured-fixed: clause 2: the costs follow the measured fixed part and focus share [C7]', () => {
  // No fixed cost and a tiny focus make focused halves nearly free, so even a pair bisects.
  assert.equal(splitBeatsBisect({ items: 2, gateMs: 600_000, fixedMs: 0, focusShare: 0.01 }).split, false);
  // A focus that is the whole plan makes a half cost a full gate, so a pair splits and so do four.
  assert.equal(splitBeatsBisect({ items: 4, gateMs: 600_000, fixedMs: 0, focusShare: 1 }).split, true);
  const costs = redBatchCosts({ items: 3, gateMs: 100, fixedMs: 50, focusShare: 0.5 });
  assert.deepEqual(costs, { splitMs: 300, bisectMs: 2 * 2 * 75 + 100, levels: 2 });
});
