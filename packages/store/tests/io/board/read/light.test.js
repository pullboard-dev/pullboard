/** The rows listItems returns carry the level and review tier that pullboard labels reads [C7,#1519]. */
// fixture-subject: addItem (a store unit test of listItems over a seeded board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import * as store from '../../../../index.js';
import { listItems } from '../../../../src/io/board/read/light.js';

/** A board with one item of each route, and each stored review policy the labels care about. */
function fixture(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  // A light route needs a recorded diagnosis, so each item is added strong and its stored route is set directly.
  const add = (title, route) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title, route: 'strong' });
    board.db.prepare('UPDATE item SET item_route=? WHERE item_id=?').run(route, id);
    return id;
  };
  const ids = { light: add('Light one', 'light'), mid: add('Mid one', 'mid'), strong: add('Strong one', 'strong') };
  const policy = (id, body) => board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(`review_independence:${id}`, JSON.stringify({ version: 1, ...body }));
  policy(ids.light, { sensitive: true, reviewFamily: null });
  policy(ids.mid, { sensitive: false, reviewFamily: 'openai' });
  policy(ids.strong, { sensitive: false, reviewFamily: null });
  return { board, ids };
}

test('store.io-board-read-light.list-rows-carry-item-level: clause 1: listItems returns item_level equal to each item route, light, mid and strong [C7,#1519]', t => {
  const { board, ids } = fixture(t);
  const rows = new Map(listItems(board).map(row => [row.item_id, row]));
  for (const route of ['light', 'mid', 'strong']) assert.equal(rows.get(ids[route]).item_level, route);
});

test('store.io-board-read-light.list-rows-carry-strict-review-tier: clause 2: listItems returns item_review_tier strict for a stored review family or sensitive true, and none for neither [C7,#1519]', t => {
  const { board, ids } = fixture(t);
  const rows = new Map(listItems(board).map(row => [row.item_id, row]));
  assert.equal(rows.get(ids.light).item_review_tier, 'strict', 'sensitive true');
  assert.equal(rows.get(ids.mid).item_review_tier, 'strict', 'a review family');
  assert.equal('item_review_tier' in rows.get(ids.strong), false, 'neither');
});

test('store.io-board-read-light.cached-list-keeps-the-labels: clause 3: a second listItems call on the unchanged board, answered from the list cache, returns the same item_level and item_review_tier [C7,#1519]', t => {
  const { board } = fixture(t);
  const pick = rows => rows.map(({ item_id: id, item_level: level, item_review_tier: tier }) => ({ id, level, tier }));
  const first = pick(listItems(board));
  const second = pick(listItems(board));
  assert.ok(first.length === 3 && first.some(row => row.tier === 'strict'));
  assert.deepEqual(second, first);
});
