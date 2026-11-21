/** The rows listItems returns carry the level and review tier that pullboard labels reads [C7,#1519]. */
// fixture-subject: addItem (a store unit test of listItems over a seeded board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import * as store from '../../../../index.js';
import { listItems } from '../../../../src/io/board/read/light.js';
import { listItemsSql } from '../../../../src/io/board/read/light.js';
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

/**
 * Insert items straight into the item table, as a board that has finished thousands of them holds them: each starts open,
 * then a status move under the move token sets its status, as the board's status trigger requires.
 */
function insertItems(board, count, status, lane, merged) {
  const insert = board.db.prepare(`INSERT INTO item (item_lane, item_title, item_created_by, item_created_at, item_updated_at) VALUES (?, ?, 'coordinator', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`);
  const first = board.db.prepare('SELECT COALESCE(MAX(item_id), 0) AS id FROM item').get().id + 1;
  board.db.exec('BEGIN');
  try { for (let at = 0; at < count; at += 1) insert.run(lane, `${status} ${at}`); board.db.exec('COMMIT'); } catch (error) { board.db.exec('ROLLBACK'); throw error; }
  if (status === 'open') return;
  // The board's verified rule needs an ACCEPT on the frozen criterion by a verifier other than the builder, at the item's commit.
  if (status === 'verified') {
    board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
      SELECT item_id, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, '2026-11-18T00:00:00Z' FROM item WHERE item_id >= ? AND item_id < ?`).run('b'.repeat(40), 'd'.repeat(64), 'b'.repeat(40), first, first + count);
  }
  // The fields each status requires, placed the way the stage tests place them: the fixture records where items stand, not how they got there.
  const built = "item_built_by='core-1', item_commit=?2, item_frozen_digest=?3";
  const fields = {
    withdrawn: "item_withdrawn_reason='not needed'",
    claimed: "item_owner='core-1', item_lease_until='2000-01-01T00:00:00.000Z', item_frozen_digest=?3",
    submitted: built,
    verified: `${built}, item_verified_by='core-2', item_merged_commit=?4`,
  }[status];
  asMove(board, `UPDATE item SET item_status=?1, ${fields} WHERE item_id >= ?5 AND item_id < ?6`, status, 'b'.repeat(40), 'd'.repeat(64), merged ? 'a'.repeat(40) : null, first, first + count);
}

/** The sorted medians helper: the middle of the measured times. */
function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

test('store.io-board-read-light.unfinished-lists-seek-status: clause 1: every scope listItemsSql builds reads the item table through an item_status index and never scans it [C7,#12581]', t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  insertItems(board, 30, 'withdrawn', 'core', false);
  insertItems(board, 5, 'open', 'core', false);
  for (const filter of [{ all: false, hasLane: false }, { all: false, hasLane: true }, { all: false, hasLane: false, inFlight: true }, { all: false, hasLane: true, inFlight: true }]) {
    const sql = listItemsSql(filter);
    const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(filter.hasLane ? ['core'] : [])).map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH item USING (?:COVERING )?INDEX item_(?:status_id|lane_status)/u, JSON.stringify(filter));
    assert.doesNotMatch(plan, /SCAN item(?! USING)/u, `${JSON.stringify(filter)}\n${plan}`);
  }
});

test('store.io-board-read-light.lists-flat-with-item-history: clause 2: the median listItems call over 50 open and 12,000 finished items is under 50 ms and at most twice the median with 50 open items alone [C7,#12581]', t => {
  const timed = (board) => median(Array.from({ length: 20 }, (_, call) => {
    // A lane no earlier call used, so no remembered list answers and each call reads the tables.
    const started = performance.now();
    listItems(board, { lane: `core${call}` });
    listItems(board);
    return performance.now() - started;
  }));
  const small = fixtureBoard(t), large = fixtureBoard(t);
  for (const board of [small, large]) { store.register(board, { lane: 'coordinator', path: '/fixture/coordinator' }); insertItems(board, 50, 'open', 'core', false); }
  insertItems(large, 6000, 'withdrawn', 'core', false);
  insertItems(large, 6000, 'verified', 'core', true);
  const base = timed(small), flat = timed(large);
  assert.ok(flat < 50, `${flat} ms with 12,000 finished items`);
  assert.ok(flat <= Math.max(base * 2, 5), `${flat} ms against ${base} ms with open items alone`);
});

test('store.io-board-read-light.scopes-return-the-same-items: clause 3: the default, in-flight and all scopes return the same items on a mixed board, a lapsed claim reads as open and an unmerged verified item is in flight [C7,#12581]', t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  insertItems(board, 2, 'open', 'core', false);
  insertItems(board, 2, 'submitted', 'core', false);
  insertItems(board, 1, 'claimed', 'web', false);
  insertItems(board, 3, 'verified', 'core', true);
  insertItems(board, 1, 'verified', 'core', false);
  insertItems(board, 2, 'withdrawn', 'core', false);
  const status = (filter) => listItems(board, filter).map(row => row.item_status).sort().join(',');
  // The claimed item has no lease, so it reads as open, as every list reads a lapsed claim.
  assert.equal(status({}), 'open,open,open,submitted,submitted');
  assert.equal(status({ inFlight: true }), 'submitted,submitted,verified');
  assert.equal(listItems(board, { all: true }).length, 11);
  assert.equal(listItems(board, { lane: 'web' }).length, 1);
});
