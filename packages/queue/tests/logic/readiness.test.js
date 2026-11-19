/** A submitted item waits only on submitted items that came before it, and an open item still waits on every in-flight item [C7,#11771]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemWaits } from '../../src/logic/readiness.js';

/** A board whose submit events give each submitted item its order, and reads that name file overlaps by the brief's file. */
function fixture(items, submitOrder) {
  const board = { db: { prepare: () => ({ all: () => submitOrder.map(([item_id, at]) => ({ item_id, at })) }) } };
  const reads = {
    laneHold: () => null,
    localDependencyIds: () => [],
    itemById: () => null,
    dependencyLabel: String,
    itemFileCollisions: (item, others) => others
      .filter(other => other.item_id !== item.item_id && other.item_file === item.item_file && ['claimed', 'submitted'].includes(other.item_status))
      .map(other => `#${item.item_id} waits for #${other.item_id} (${other.item_status}) on ${item.item_file}`),
  };
  return { board, reads, items };
}
const waits = ({ board, reads, items }, item) => itemWaits(board, item, items, () => [], reads);

test('queue.readiness.submitted-overlap-is-ordered: of two submitted items that name one file, only the later-submitted one waits, on the earlier, and the earlier shows no wait for that file [C7,#11771]', () => {
  const first = { item_id: 57, item_status: 'submitted', item_file: 'a.js' };
  const second = { item_id: 58, item_status: 'submitted', item_file: 'a.js' };
  const world = fixture([first, second], [[58, 9], [57, 4]]);
  assert.deepEqual(waits(world, first), []);
  assert.deepEqual(waits(world, second), ['#58 waits for #57 (submitted) on a.js']);
});

test('queue.readiness.open-still-waits: an open item still waits on every claimed or submitted item that names its file [C7,#11771]', () => {
  const open = { item_id: 60, item_status: 'open', item_file: 'a.js' };
  const claimed = { item_id: 61, item_status: 'claimed', item_file: 'a.js' };
  const submitted = { item_id: 62, item_status: 'submitted', item_file: 'a.js' };
  const world = fixture([open, claimed, submitted], [[62, 3]]);
  assert.deepEqual(waits(world, open), ['#60 waits for #61 (claimed) on a.js', '#60 waits for #62 (submitted) on a.js']);
});
