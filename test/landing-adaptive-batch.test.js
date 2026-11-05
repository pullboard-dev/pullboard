/** Automatic landing sizes batches from recorded batches, and line.landingBatchSize overrides the size for real landing [C7,H24]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { landingBatchSize } from '../packages/landing/index.js';
import { roundFailures } from '../packages/landing/src/core/landing-batch-size.js';
import { landingMaximum } from '../packages/landing/src/shell/landing-step-selection.js';

const landed = { state: 'trunk' };
const blocked = { state: 'blocked' };

test('clause 1: the adaptive size starts at 4, halves after a blocked or bisected batch and doubles after a landed one, within 1-16 [C7,H24]', () => {
  assert.equal(landingBatchSize([]), 4);
  assert.equal(landingBatchSize([blocked]), 2);
  assert.equal(landingBatchSize([blocked, blocked]), 1);
  assert.equal(landingBatchSize([blocked, blocked, blocked, blocked]), 1, 'never below 1');
  assert.equal(landingBatchSize([landed]), 8);
  assert.equal(landingBatchSize([landed, landed]), 16);
  assert.equal(landingBatchSize([landed, landed, landed, landed]), 16, 'never above 16');
  assert.equal(landingBatchSize([landed, landed, blocked]), 8, 'half the last size after a red');
  assert.equal(landingBatchSize([{ state: 'pushed', culprits: [{ id: 7 }] }]), 2, 'a batch that bisected out a culprit counts as red');
  assert.equal(landingBatchSize([blocked, { state: 'blocked', dropped: 'every item already landed another way' },
    { state: 'blocked', supersededByMain: 'a'.repeat(40) }, { state: 'gating' }]), 2, 'drops, superseded batches and unfinished ones say nothing about redness');
});

test('clause 2: line.landingBatchSize overrides the adaptive size for real landing, and per-item landing keeps one [C7,H24]', t => {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/adaptive/main' });
  const batched = { landing: { perItem: false } };
  assert.equal(landingMaximum(board, batched, Infinity, true), 4, 'automatic landing with no history: the starting size');
  assert.equal(landingMaximum(board, batched, 2, true), 2, 'a caller limit below the size holds');
  assert.equal(landingMaximum(board, batched), Infinity, 'a hand landing with no setting still takes every waiting item');
  assert.equal(landingMaximum(board, { landing: { perItem: true } }), 1);
  store.setLineSetting(board, { agentId: 'coordinator', key: 'landingBatchSize', value: 6, reason: 'Measured fixture batch size',
    window: { windowMinutes: 60, activeReviewers: 2, reviewWaitMedianMinutes: 40 } });
  assert.equal(landingMaximum(board, batched, Infinity, true), 6, 'the setting wins over the adaptive size');
  assert.equal(landingMaximum(board, batched), 6, 'and applies to a hand landing too');
});

test('clause 1: the size folds every recorded batch, so a long run of red/green pairs never resets it [C7]', () => {
  const pairs = Array.from({ length: 8 }, () => [blocked, landed]).flat();
  assert.equal(landingBatchSize([landed, landed, ...pairs]), 16, 'two greens then eight red/green pairs stays at 16');
});

test('clause 1: at a cap of 1, two items that stay red never shut out a third, which lands [C7]', () => {
  const red = id => ({ state: 'blocked', items: [{ id }] });
  // Simulate selection at cap 1: untried items first in accept order, then failures oldest first.
  const pick = (batches, waiting) => {
    const failed = roundFailures(batches, waiting);
    return [...waiting].sort((a, b) => (failed.has(a) ? 1 : 0) - (failed.has(b) ? 1 : 0) || (failed.get(a) ?? 0) - (failed.get(b) ?? 0) || a - b)[0];
  };
  const batches = [];
  let waiting = [1, 2, 3], landedC = false;
  for (let round = 0; round < 6 && !landedC; round += 1) {
    const chosen = pick(batches, waiting);
    if (chosen === 3) { batches.push({ state: 'landed', items: [{ id: 3 }] }); waiting = waiting.filter(id => id !== 3); landedC = true; }
    else batches.push(red(chosen));
  }
  assert.equal(landedC, true, 'C is picked once A and B have each failed this round');
  assert.deepEqual(batches.map(batch => batch.items[0].id), [1, 2, 3]);
  assert.deepEqual([...roundFailures([red(1), red(2), red(1)], [1, 2])], [[1, 0]], 'a round where every waiting item failed starts over: only the new round\'s failure counts');
  assert.deepEqual([...roundFailures([red(1), { state: 'landed', items: [{ id: 5 }] }], [1, 2])], [], 'a landing starts a new round');
});

test('clause 1: a repeated selection folds only new batches and matches a full fold [C7]', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({ id: `b${index}`, state: index % 3 ? 'landed' : 'blocked' }));
  const full = landingBatchSize(history);
  assert.equal(landingBatchSize([...history, { id: 'live', state: 'gating' }]), full, 'an unfinished batch says nothing');
  assert.equal(landingBatchSize([...history, { id: 'new', state: 'landed' }]), Math.min(16, full * 2), 'a new landed batch folds onto the cached size');
  assert.equal(landingBatchSize([{ id: 'other', state: 'blocked' }]), 2, 'a different history folds afresh');
});
