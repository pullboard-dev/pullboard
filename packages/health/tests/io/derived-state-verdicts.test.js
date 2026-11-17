// fixture-subject: addItem (a unit test of the derived-state verdict sweep over seeded accepted items; the board is opened through the fixture kit)
/** The derived-state sweep adds verdict freshness and accept order, keyed by main commit, beside the board [C7,#8944,#8976]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../store/index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { sweepDerivedVerdicts } from '../../index.js';
import { derivedStatePath } from '../../index.js';

const MAIN = 'c'.repeat(40);
const NEXT_MAIN = 'd'.repeat(40);

/** The verdict freshness `next` reads for an item: item 2 is stale, the rest fresh (null). */
const verdictState = item => (item.item_id === 2 ? { code: 'STALE_VERDICT', file: 'a.txt', commit: 'e'.repeat(40), reviewedTrunk: MAIN, main: NEXT_MAIN } : null);

/** A file-backed board with three accepted items, accepted in the order given, one more accepted then landed, and one unaccepted. */
function acceptedBoard(t, order = [3, 1, 2]) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const ids = [1, 2, 3, 4, 5].map(n => store.addItem(board, { by: 'coordinator', lane: 'web', title: `Item number ${n}` }));
  const accept = id => board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-16T00:00:00.000Z', 'fixture', 'accept', ?, '{}')").run(id);
  for (const n of order) accept(ids[n - 1]);
  accept(ids[3]);
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  /** The item reader: items 1-3 accepted and unlanded, 4 accepted and landed, 5 never accepted. */
  const listItems = () => ids.map((id, index) => ({ item_id: id, item_status: index < 4 ? 'verified' : 'open', item_merged_commit: index === 3 ? 'f'.repeat(40) : null }));
  return { board, file, ids, listItems };
}

/** The rows of the derived file for one commit and kind, in key order. */
function rows(file, commit, kind) {
  const derived = new DatabaseSync(derivedStatePath(file), { readOnly: true });
  try { return derived.prepare('SELECT key, value FROM derived_state WHERE main_commit = ? AND kind = ? ORDER BY CAST(key AS INTEGER)').all(commit, kind); }
  finally { derived.close(); }
}

/** The verdict states the sweep is handed, mapped from the board's ids to this fixture's item numbers. */
const stateFor = ids => item => verdictState({ ...item, item_id: ids.indexOf(item.item_id) + 1 });

test('clause 1: with health.derivedState on, the sweep writes verdict freshness rows equal to what next computes for the same main commit [C7,#8976]', t => {
  const { board, file, ids, listItems } = acceptedBoard(t);
  const written = sweepDerivedVerdicts(board, { mainCommit: MAIN, enabled: true, listItems, verdictState: stateFor(ids) });
  assert.equal(written.file, derivedStatePath(file));
  const computed = listItems().filter(item => item.item_status === 'verified' && !item.item_merged_commit)
    .map(item => [String(item.item_id), JSON.stringify(stateFor(ids)(item))]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(rows(file, MAIN, 'verdict').map(row => [row.key, row.value]), computed);
  assert.equal(rows(file, MAIN, 'verdict').length, 3, 'only accepted, unlanded items carry a freshness row');
  assert.equal(JSON.parse(rows(file, MAIN, 'verdict').find(row => row.key === String(ids[1])).value).code, 'STALE_VERDICT');
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'derived_state'").get().n, 0, 'the board database holds no derived table');
});

test('clause 2: the accept-order rows equal the board accept order for that commit [C7,#8976]', t => {
  const { board, file, ids, listItems } = acceptedBoard(t, [3, 1, 2]);
  sweepDerivedVerdicts(board, { mainCommit: MAIN, enabled: true, listItems, verdictState: stateFor(ids) });
  const order = rows(file, MAIN, 'accept-order');
  assert.deepEqual(order.sort((a, b) => a.value - b.value).map(row => Number(row.key)), [ids[2], ids[0], ids[1]], 'oldest accept first');
  const boardOrder = board.db.prepare("SELECT item_id, MAX(event_id) AS event_id FROM event WHERE event_kind = 'accept' AND item_id IN (?, ?, ?) GROUP BY item_id").all(ids[0], ids[1], ids[2]);
  assert.deepEqual(order.map(row => [Number(row.key), Number(row.value)]).sort((a, b) => a[0] - b[0]), boardOrder.map(row => [row.item_id, row.event_id]).sort((a, b) => a[0] - b[0]));
});

test('clause 3: a new main commit gets its own rows and leaves the old commit rows unread [C7,#8976]', t => {
  const { board, file, ids, listItems } = acceptedBoard(t);
  sweepDerivedVerdicts(board, { mainCommit: MAIN, enabled: true, listItems, verdictState: stateFor(ids) });
  const oldVerdicts = rows(file, MAIN, 'verdict');
  const oldOrder = rows(file, MAIN, 'accept-order');
  sweepDerivedVerdicts(board, { mainCommit: NEXT_MAIN, enabled: true, listItems, verdictState: () => null });
  assert.deepEqual(rows(file, NEXT_MAIN, 'verdict').map(row => row.value), ['null', 'null', 'null'], 'the new commit has its own freshness');
  assert.equal(rows(file, NEXT_MAIN, 'accept-order').length, 3);
  assert.deepEqual(rows(file, MAIN, 'verdict'), oldVerdicts, 'the old commit rows are untouched');
  assert.deepEqual(rows(file, MAIN, 'accept-order'), oldOrder);
});

test('clause 4: with health.derivedState off the verdict sweep writes no file [C7,#8976]', t => {
  const { board, file, ids, listItems } = acceptedBoard(t);
  assert.equal(sweepDerivedVerdicts(board, { mainCommit: MAIN, enabled: false, listItems, verdictState: stateFor(ids) }), null);
  assert.equal(sweepDerivedVerdicts(board, { mainCommit: MAIN, listItems, verdictState: stateFor(ids) }), null);
  assert.equal(existsSync(derivedStatePath(file)), false);
});
