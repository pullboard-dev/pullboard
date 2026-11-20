/** Returned work is offered first: abandoned and reworked items lead untouched ones, held items are left out [C7,#2220]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { returnedFirst } from '../../src/logic/returned.js';

const ids = rows => rows.map(row => row.id);

test('queue.returned.returned-items-lead-untouched: clause 1: returnedFirst puts an abandoned or rework item ahead of an untouched item of the same or lower rank and keeps the original order inside each group [C7]', () => {
  const queue = [
    { id: 1, rank: 1 }, { id: 2, rank: 1 }, { id: 3, rank: 1 }, { id: 4, rank: 1 }, { id: 5, rank: 2 }, { id: 6, rank: 2 },
  ];
  const reasons = { 3: 'abandoned', 4: 'rework', 6: 'rework' };
  assert.deepEqual(ids(returnedFirst(queue, reasons)), [3, 4, 1, 2, 6, 5]);
});

test('queue.returned.never-passes-a-more-urgent-rank: clause 1: returnedFirst keeps a returned item behind an untouched item of a more urgent rank [C7]', () => {
  const queue = [{ id: 1, rank: 1 }, { id: 2, rank: 2 }];
  assert.deepEqual(ids(returnedFirst(queue, { 2: 'abandoned' })), [1, 2]);
});

test('queue.returned.leaves-out-wall-decision-blocked: clause 2: returnedFirst leaves out an item whose stop reason is wall, decision or blocked [C7]', () => {
  const queue = [{ id: 1, rank: 1 }, { id: 2, rank: 1 }, { id: 3, rank: 1 }, { id: 4, rank: 1 }];
  const reasons = { 1: 'wall', 2: 'decision', 3: 'blocked', 4: 'rework' };
  assert.deepEqual(ids(returnedFirst(queue, reasons)), [4]);
});
