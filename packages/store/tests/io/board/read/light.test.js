/** The rows listItems returns carry the level and review tier that pullboard labels reads [C7,#1519]. */
// fixture-subject: addItem (a store unit test of listItems over a seeded board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import * as store from '../../../../index.js';
import { listItems } from '../../../../src/io/board/read/light.js';
import { withItemSnapshot } from '../../../../src/io/board/read/light.js';
import { openBoardForRead } from '../../../../src/io/board/read/snapshot.js';

const HOUR = 60 * 60 * 1000;
/** The minimal frozen bar a claim needs. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

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

/** Run a raw status write under the move token the board's status trigger requires. */
function asMove(board, sql, ...args) {
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try { board.db.prepare(sql).run(...args); } finally { board.db.exec('DELETE FROM temp.moving'); }
}

/** A file board with open, claimed, submitted and verified items in two lanes, and a free core seat to pick for. */
function snapshotFixture(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  store.register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  const builder = store.register(board, { lane: 'core', path: '/fixture/builder', route: 'strong' });
  const picker = store.register(board, { lane: 'core', path: '/fixture/picker', route: 'strong' });
  const shipper = store.register(board, { lane: 'core', path: '/fixture/shipper', route: 'strong' });
  const add = (lane, title) => store.addItem(board, { by: 'coordinator', lane, title });
  const ids = { claimed: add('core', 'Claimed one'), submitted: add('core', 'Submitted one'), verified: add('web', 'Verified one'),
    open: add('core', 'Open one'), web: add('web', 'Web one') };
  store.claim(board, ids.claimed, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  store.claim(board, ids.submitted, { agentId: shipper, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  // Fixture shortcuts to the submitted and verified statuses: the submit move needs a repository this file board does not have.
  asMove(board, "UPDATE item SET item_status='submitted', item_built_by=?, item_commit=? WHERE item_id=?", shipper, '1'.repeat(40), ids.submitted);
  // The board's verified rule needs an ACCEPT on the frozen criterion by a verifier other than the builder, at the item's commit.
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (?, ?, 'ACCEPT', 'CRITERION_MET', 'fixture', ?, 'light-fixture', ?, '2026-10-06T00:00:00Z')`).run(ids.verified, picker, '2'.repeat(40), '2'.repeat(40));
  asMove(board, "UPDATE item SET item_status='verified', item_verified_by=?, item_built_by=?, item_frozen_digest='light-fixture', item_commit=?, item_merged_commit=? WHERE item_id=?", picker, shipper, '2'.repeat(40), '2'.repeat(40), ids.verified);
  return { board, file: board.db.location(), builder, picker, ids };
}

/** Every list a next phase asks for, through one read-only connection, and the pick nextFor makes for the free seat. */
function lists(file, picker) {
  const read = openBoardForRead(file);
  try {
    const ids = rows => rows.map(row => [row.item_id, row.item_status, row.item_stage]);
    return { all: ids(listItems(read, { all: true })), open: ids(listItems(read)), inFlight: ids(listItems(read, { inFlight: true })),
      web: ids(listItems(read, { lane: 'web' })), pick: store.nextFor(read, { agentId: picker, lane: 'core' }).item?.item_id ?? null };
  } finally { store.closeBoard(read); }
}

test('store.io-board-read-light.snapshot-same-answer: clause 1: inside withItemSnapshot, listItems all, open, in-flight and per lane from two read-only connections, and the nextFor pick, equal the same calls outside a snapshot [C7,N2,#12010]', t => {
  const { file, picker, ids } = snapshotFixture(t);
  const plain = lists(file, picker);
  assert.equal(plain.pick, ids.open, 'the free core seat is offered the open core item');
  assert.equal(plain.all.length, 5);
  const [first, second] = withItemSnapshot(() => [lists(file, picker), lists(file, picker)]);
  assert.deepEqual(first, plain);
  assert.deepEqual(second, plain);
});

test('store.io-board-read-light.snapshot-reads-once: clause 1: listItems all, open and in-flight from two read-only connections in one withItemSnapshot make one table read, also after another connection commits an unrelated board_meta row [C7,N2,#12010]', t => {
  const { board, file } = snapshotFixture(t);
  const ids = rows => rows.map(row => row.item_id);
  const state = { reads: 0 };
  const seen = withItemSnapshot(() => {
    const read = (work) => { const opened = openBoardForRead(file); try { return work(opened); } finally { store.closeBoard(opened); } };
    const before = read(opened => [listItems(opened, { all: true }), listItems(opened), listItems(opened, { inFlight: true })].map(ids));
    // Another process's commit, made without this process's write lock: it moves data_version but not the scope.
    board.db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES(?, ?)').run('sp3:unrelated', '1');
    const after = read(opened => [listItems(opened, { all: true }), listItems(opened), listItems(opened, { inFlight: true })].map(ids));
    return { before, after };
  }, state);
  assert.equal(state.reads, 1);
  assert.deepEqual(seen.after, seen.before);
  assert.equal(seen.before[0].length, 5);
});

test('store.io-board-read-light.snapshot-write-refreshes: clause 1: after a write board in the same withItemSnapshot claims an item and closes, the next read-only listItems shows the claim [C7,N2,#12010]', t => {
  const { board, file, picker, ids } = snapshotFixture(t);
  const state = { reads: 0 };
  const statusOf = () => { const read = openBoardForRead(file); try { return listItems(read).find(row => row.item_id === ids.open).item_status; } finally { store.closeBoard(read); } };
  const [before, after] = withItemSnapshot(() => {
    const first = statusOf();
    store.claim(board, ids.open, { agentId: picker, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
    return [first, statusOf()];
  }, state);
  assert.equal(before, 'open');
  assert.equal(after, 'claimed');
  assert.equal(state.reads, 2);
});
