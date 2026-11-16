// fixture-subject: addItem (a unit test of the derived-state sweep over seeded held items; the board is opened through the fixture kit)
/** The derived-state sweep writes holds keyed by main commit beside the board, never into it [C7,#8944]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../store/index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { sweepDerivedHolds } from '../../index.js';
import { derivedStatePath } from '../../index.js';

const MAIN = 'b'.repeat(40);

/** A file-backed board with two held items and one free one, and its board file's path. */
function heldBoard(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const held = ['First held item', 'Second held item'].map(title => store.addItem(board, { by: 'coordinator', lane: 'web', title }));
  store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Free item' });
  for (const id of held) store.holdItem(board, id, { agentId: 'coordinator', reason: `Private hold on ${id}` });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  return { board, file, held };
}

/** The rows of the derived file for one commit and kind. */
function rows(file, kind) {
  const derived = new DatabaseSync(derivedStatePath(file), { readOnly: true });
  try { return derived.prepare('SELECT key, value FROM derived_state WHERE main_commit = ? AND kind = ? ORDER BY CAST(key AS INTEGER)').all(MAIN, kind); }
  finally { derived.close(); }
}

test('clause 1: with health.derivedState on, the sweep writes rows keyed by main commit and kind to a derived file beside the board, never the board database [C7]', t => {
  const { board, file } = heldBoard(t);
  const before = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const written = sweepDerivedHolds(board, { mainCommit: MAIN, enabled: true, listItems: store.listItems });
  assert.equal(written.file, derivedStatePath(file));
  assert.notEqual(written.file, file, 'a separate file');
  assert.ok(written.file.startsWith(file.slice(0, file.lastIndexOf('/'))), 'beside the board file');
  assert.equal(rows(file, 'hold').length, 2);
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, before, 'the board database gained no event');
  const tables = board.db.prepare("SELECT name FROM sqlite_master WHERE name = 'derived_state'").all();
  assert.deepEqual(tables, [], 'the board database holds no derived table');
});

test('clause 2: the holds rows equal the holds the board reports for the same main commit [C7]', t => {
  const { board, file, held } = heldBoard(t);
  sweepDerivedHolds(board, { mainCommit: MAIN, enabled: true, listItems: store.listItems });
  const reported = store.listItems(board).filter(item => item.item_hold_at).map(item => [String(item.item_id), item.item_hold_reason]);
  assert.deepEqual(rows(file, 'hold').map(row => [row.key, JSON.parse(row.value).reason]), reported);
  assert.deepEqual(rows(file, 'hold').map(row => Number(row.key)), held);
  // A lifted hold leaves the next sweep at the same commit: rows follow the board, not the old file.
  store.releaseItemHold(board, held[0], { agentId: 'coordinator' });
  sweepDerivedHolds(board, { mainCommit: MAIN, enabled: true, listItems: store.listItems });
  assert.deepEqual(rows(file, 'hold').map(row => Number(row.key)), [held[1]]);
});

test('clause 3: with health.derivedState off the sweep writes no file [C7]', t => {
  const { board, file } = heldBoard(t);
  assert.equal(sweepDerivedHolds(board, { mainCommit: MAIN, enabled: false, listItems: store.listItems }), null);
  assert.equal(sweepDerivedHolds(board, { mainCommit: MAIN, listItems: store.listItems }), null, 'an unset setting is off');
  assert.equal(existsSync(derivedStatePath(file)), false);
});
