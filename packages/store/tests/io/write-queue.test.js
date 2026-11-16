/** The board write-queue port applies writes in submission order and isolates failures [C7,#8925]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWriteQueue } from '../../src/io/write-queue.js';

test('clause 1: writes submitted to the write-queue port apply one at a time in submission order [C7,#8925]', async () => {
  const queue = createWriteQueue();
  const order = [];
  let running = 0;
  let overlap = false;
  const write = (name, turns) => queue.submit(async () => {
    running++;
    if (running > 1) overlap = true;
    for (let turn = 0; turn < turns; turn++) await Promise.resolve();
    order.push(name);
    running--;
    return name;
  });
  const results = await Promise.all([write('a', 20), write('b', 1), write('c', 10)]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(overlap, false);
  assert.equal(queue.pending(), 0);
});

test('clause 2: a failed write rejects only its own caller and later writes still apply [C7,#8925]', async () => {
  const queue = createWriteQueue();
  const order = [];
  const first = queue.submit(() => { order.push('first'); });
  const bad = queue.submit(() => { throw new Error('boom'); });
  const last = queue.submit(() => { order.push('last'); return 'ok'; });
  await first;
  await assert.rejects(bad, /boom/u);
  assert.equal(await last, 'ok');
  assert.deepEqual(order, ['first', 'last']);
});
