import test from 'node:test';
import assert from 'node:assert/strict';
import { itemFileCollisions } from '../../../../items/index.js';
import { itemFiles } from '../../../../items/index.js';
import { loadavg } from 'node:os';
import { availableParallelism } from 'node:os';
import { wallLoadFactor } from '../../../../drive/light.js';
import { readyItems } from '../../../../queue/index.js';
import { reviewQueueLine as indexReviewQueueLine } from '../../../index.js';
import { reviewQueueLine as lightReviewQueueLine } from '../../../light.js';

/** The pre-index reference: every candidate against every item. */
function naive(item, items) {
  const files = new Set(itemFiles({ item_brief: item.item_brief }).length ? itemFiles({ item_brief: item.item_brief }) : []);
  return items.filter(o => o.item_id !== item.item_id && (o.item_status === 'claimed' || o.item_status === 'submitted'
    || (o.item_status === 'verified' && !o.item_merged_commit)))
    .map(o => ({ o, shared: itemFiles(o).filter(p => files.has(p)) })).filter(x => x.shared.length)
    .map(x => `#${item.item_id} waits for #${x.o.item_id} (${x.o.item_status}) on ${x.shared.join(', ')}`);
}

/** @param {number} n
 * @param {number} [mod] */
function fixture(n, mod = 50) {
  return Array.from({ length: n }, (_, i) => ({
    item_id: i + 1, item_lane: 'core', item_status: i % 3 === 0 ? 'claimed' : 'open',
    item_brief: `Files:\n- src/mod${i % mod}.js\n- src/own${i}.js\nChange:\n  x`,
  }));
}

test('verify.queue.path-index: clause 1: queue and status find file collisions through a path index and match the all-pairs answer [C7]', () => {
  const items = fixture(300);
  for (const item of items) assert.deepEqual(itemFileCollisions(item, items), naive(item, items));
  assert.ok(itemFileCollisions(items[1], items).length > 0);
});

test('verify.queue.speed: clause 2: queue on a 3,000-item fixture runs in under 200 ms [C7]', () => {
  const items = fixture(3000, 4000);
  const reads = {
    listItems: () => items, laneHolds: () => [], laneHold: () => null, localDependencyIds: () => [],
    itemById: () => null, dependencyLabel: () => '', itemFileCollisions,
  };
  const start = performance.now();
  const ready = readyItems({ nativePorts: reads }, () => [], reads);
  const ms = performance.now() - start;
  assert.ok(ready.length >= 2000);
  const budgetMs = 200 * wallLoadFactor(loadavg()[0], availableParallelism());
  assert.ok(ms < budgetMs, `took ${ms.toFixed(0)} ms of ${budgetMs.toFixed(0)}`);
});

/** The light door answers as the index door does, so a status caller no longer needs the heavy front door [C7]. */
test('verify.review-queue.light-door-exports-line: the light door exports the index door\'s reviewQueueLine [C7]', () => {
  assert.equal(typeof lightReviewQueueLine, 'function');
  assert.equal(lightReviewQueueLine, indexReviewQueueLine, 'one function behind both doors');
});
