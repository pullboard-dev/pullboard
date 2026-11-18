/** A child board learns which open parent items wait on its items, from the parent's item rows alone [RB24]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitedOnItems } from '../../../../src/io/board/link/waiting.js';

/** One parent item row: id, status and its after list. */
const row = (id, status, after) => ({ item_id: id, item_status: status, item_after: after });

test('store.io-board-link-waiting.lists-waiting-parents: clause 1: waitedOnItems(parentItems, childHandle) returns, for each child item an open parent item names as childHandle#id, the sorted parent item ids that wait on it [RB24]', () => {
  const waiting = waitedOnItems([row(30, 'open', ['kid#7']), row(10, 'building', ['kid#7', 'kid#9'])], 'kid');
  assert.deepEqual([...waiting], [[7, [10, 30]], [9, [10]]]);
});

test('store.io-board-link-waiting.skips-done-local-and-other: clause 2: a verified or withdrawn parent item, a local dependency and a foreign dependency on another handle are not counted [RB24]', () => {
  const waiting = waitedOnItems([row(1, 'verified', ['kid#7']), row(2, 'withdrawn', ['kid#7']), row(3, 'open', [5]), row(4, 'open', ['other#7'])], 'kid');
  assert.equal(waiting.size, 0);
});

test('store.io-board-link-waiting.one-entry-each-parent-once: clause 3: a parent item naming childHandle#7 twice, or two parent items naming it, give one entry for 7 with each parent id once [RB24]', () => {
  const waiting = waitedOnItems([row(2, 'open', ['kid#7', 'kid#7']), row(2, 'open', ['kid#7']), row(1, 'open', ['kid#7'])], 'kid');
  assert.deepEqual([...waiting], [[7, [1, 2]]]);
});
