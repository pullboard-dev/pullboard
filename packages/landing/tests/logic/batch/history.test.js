/** Automatic landing sizes batches from recorded batches, and line.landingBatchSize overrides the size for real landing [C7,H24]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../../store/tests/fixtures/cell.js';
import { landingBatchSize } from '../../../index.js';
import { roundFailures } from '../../../index.js';
import { landingMaximum } from '../../../index.js';

const landed = { state: 'trunk' };
const blocked = { state: 'blocked' };

test('clause 1: the adaptive size starts at 4, halves after a blocked or bisected batch and doubles after three landed in a row, within 1-16 [C7,H24]', () => {
  assert.equal(landingBatchSize([]), 4);
  assert.equal(landingBatchSize([blocked]), 2);
  assert.equal(landingBatchSize([blocked, blocked]), 1);
  assert.equal(landingBatchSize([blocked, blocked, blocked, blocked]), 1, 'never below 1');
  assert.equal(landingBatchSize([landed]), 4, 'one green does not grow the size');
  assert.equal(landingBatchSize([landed, landed]), 4, 'nor two');
  assert.equal(landingBatchSize([landed, landed, landed]), 8, 'three landed in a row double it');
  assert.equal(landingBatchSize([landed, landed, landed, landed, landed]), 8, 'the next run of three starts after a step');
  assert.equal(landingBatchSize(Array(6).fill(landed)), 16);
  assert.equal(landingBatchSize(Array(9).fill(landed)), 16, 'never above 16');
  assert.equal(landingBatchSize([landed, landed, blocked]), 2, 'a red halves at once and ends the green run');
  assert.equal(landingBatchSize([landed, landed, blocked, landed, landed, landed]), 4, 'three greens after a red grow again');
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
  assert.equal(landingBatchSize([...Array(6).fill(landed), ...pairs]), 1, 'six greens reach 16; eight red/green pairs then halve it to 1, since a single green never grows it');
});

test('clause 1: at a cap of 1, items that stay red take turns, a third still lands, and one that turns green lands [C7]', () => {
  const red = (id, n) => ({ id: `r${n}`, state: 'blocked', items: [{ id }] });
  // Selection at cap 1: untried items first in accept order, then failures least recently failed first.
  const pick = (batches, waiting) => {
    const failed = roundFailures(batches);
    return [...waiting].sort((a, b) => (failed.has(a) ? 1 : 0) - (failed.has(b) ? 1 : 0) || (failed.get(a) ?? 0) - (failed.get(b) ?? 0) || a - b)[0];
  };
  const batches = [], picked = [];
  let waiting = [1, 2, 3];
  const greenAfter = new Map([[2, 2]]); // B turns green on its second turn
  const turns = new Map();
  for (let n = 0; n < 8 && waiting.length > 1; n += 1) {
    const chosen = pick(batches, waiting);
    picked.push(chosen);
    turns.set(chosen, (turns.get(chosen) ?? 0) + 1);
    const lands = chosen === 3 || greenAfter.get(chosen) === turns.get(chosen);
    if (lands) { batches.push({ id: `l${n}`, state: 'landed', items: [{ id: chosen }] }); waiting = waiting.filter(id => id !== chosen); }
    else batches.push(red(chosen, n));
  }
  assert.deepEqual(picked.slice(0, 3), [1, 2, 3], 'A and B fail, then C, untried, is picked and lands');
  assert.deepEqual(picked.slice(3, 5), [1, 2], 'A and B take turns by least recent failure, and B lands when it turns green');
  assert.deepEqual(waiting, [1], 'only the item still red is left');
});

test('clause 1: a repeated selection folds only new batches and matches a full fold [C7]', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({ id: `b${index}`, state: index % 3 ? 'landed' : 'blocked' }));
  const full = landingBatchSize(history);
  assert.equal(landingBatchSize([...history, { id: 'live', state: 'gating' }]), full, 'an unfinished batch says nothing');
  assert.equal(landingBatchSize([...history, { id: 'new', state: 'landed' }]), full, 'a new landed batch folds onto the cached size; one green after a red does not grow it');
  assert.equal(landingBatchSize([{ id: 'other', state: 'blocked' }]), 2, 'a different history folds afresh');
});

test('clause 1: a revised earlier batch refolds the size and the failure turns, never a stale cached result [C7]', () => {
  const history = Array.from({ length: 10 }, (_, index) => ({ id: `b${index}`, state: index === 2 ? 'blocked' : 'landed', items: [{ id: index + 1 }] }));
  assert.equal(landingBatchSize(history), 8, 'two greens, a red to 2, then seven greens: 4 at the third, 8 at the sixth');
  assert.deepEqual([...roundFailures(history)], [[3, 1]]);
  // The earlier blocked batch is rewritten under its id: every item already landed another way, so it says nothing.
  const dropped = history.map(batch => batch.id === 'b2' ? { ...batch, dropped: 'every item already landed another way' } : batch);
  assert.equal(landingBatchSize(dropped), 16, 'nine greens with no red: 8, then 16, from a refold');
  assert.deepEqual([...roundFailures(dropped)], [], 'a dropped batch no longer stamps a failure');
  // An earlier landed batch is revised to blocked with a culprit while the last batch keeps its id and state.
  const revised = history.map(batch => batch.id === 'b0' ? { ...batch, state: 'blocked', culprits: [{ id: 1 }] } : batch);
  const short = [{ id: 's0', state: 'landed' }, { id: 's1', state: 'blocked' }, { id: 's2', state: 'gating' }];
  assert.equal(landingBatchSize(short), 2, 'green then red: 4 then 2');
  assert.equal(landingBatchSize([{ ...short[0], state: 'blocked' }, ...short.slice(1)]), 1, 'the earlier batch turned red under the same last batch: 2 then 1');
  assert.deepEqual([...roundFailures(revised)].sort((a, b) => a[0] - b[0]), [[1, 1], [3, 2]], 'the revised batch stamps its item first');
  const items = history.map(batch => batch.id === 'b2' ? { ...batch, items: [{ id: 30 }] } : batch);
  assert.deepEqual([...roundFailures(items)], [[30, 1]], 'a changed item list moves the failure to the new item');
});

test('clause 1: a batch stopped by a refusal that names no failing test never shrinks the next batch [C7]', () => {
  const locked = { state: 'blocked', failures: [{ file: null, name: 'never ran: the resource queue database stayed locked' }],
    refusal: { code: 'SLOT_DB_LOCKED', message: 'never ran', at: '2026-11-05T16:27:14.000Z' } };
  assert.equal(landingBatchSize([locked, locked, locked]), 4, 'infrastructure refusals keep the starting size');
  assert.equal(landingBatchSize([landed, landed, landed, locked]), 8, 'and keep a grown size');
});

test('clause 2: a blocked batch with a named failing test or a culprit still halves the next batch [C7]', () => {
  const locked = { state: 'blocked', failures: [{ file: null, name: 'never ran: the resource queue database stayed locked' }],
    refusal: { code: 'SLOT_DB_LOCKED', message: 'never ran', at: '2026-11-05T16:27:14.000Z' } };
  const testRed = { state: 'blocked', failures: [{ file: 'test/a.test.js', name: 'case' }], refusal: { code: 'LAND_DIAGNOSTIC', message: 'red', at: '2026-11-05T16:00:00.000Z' } };
  assert.equal(landingBatchSize([testRed]), 2, 'a refusal over a named failing test still halves it');
  assert.equal(landingBatchSize([{ ...locked, culprits: [{ id: 3 }] }]), 2, 'a culprit still halves it');
});

test('clause 3: revising a blocked batch from an infrastructure refusal to a named red refolds the size [C7]', () => {
  const id = 'b-1';
  const first = [{ id, state: 'blocked', failures: [{ file: null, name: 'locked' }], refusal: { code: 'SLOT_DB_LOCKED', message: 'x', at: 'a' } }];
  assert.equal(landingBatchSize(first), 4);
  const revised = [{ id, state: 'blocked', failures: [{ file: 'test/a.test.js', name: 'case' }], refusal: { code: 'SLOT_DB_LOCKED', message: 'x', at: 'a' } }];
  assert.equal(landingBatchSize(revised), 2, 'the same id and state with a named red is red, never the cached infrastructure result');
});
