/** Contract: an in-memory board answers the same writes and reads as an on-disk board, for what tests use [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { cellBoard } from '../fixtures/cell-board.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { temporaryRepository } from '../../../store/tests/fixtures/submit.js';

const COMMIT = 'a'.repeat(40);
const POLICY = { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } };

/** Open a board on a fixed clock the script advances the same way for both; both name the one repository, so sealed policy matches. */
function open(t, where, repo) {
  let at = Date.parse('2026-03-01T00:00:00Z');
  const file = where === 'disk' ? join(repo, '.git', 'pullboard', 'board.sqlite') : ':memory:';
  return { board: cellBoard(t, file, { now: () => new Date(at) }, { gitRoot: repo }), tick: minutes => { at += minutes * 60_000; } };
}

/** The refusal code a move raises, or null when it succeeds; a code the stand-in must reproduce. */
function refusal(move) {
  try { move(); return null; } catch (error) { return error.code ?? error.message; }
}

/** The same board writes, in the same order, whatever the board is stored in; returns what the reads said. */
function script({ board, tick }) {
  const seen = {};
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder', family: 'Contract Builder Vendor', route: 'mid' });
  const other = cellSeat(board, { lane: 'core', path: '/other', family: 'Contract Reviewer Vendor', route: 'mid' });
  store.setLineSetting(board, { agentId: 'coordinator', key: 'requireReviewFamilies', value: true,
    reason: 'Private fixture explicitly requires declared vendor pairs; this changes no operational board.',
    window: { syntheticPolicy: 1 } });
  const filed = [
    cellItem(board, { lane: 'core', title: 'first', criterion: 'one', specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves the first' }),
    cellItem(board, { lane: 'core', title: 'second', criterion: 'two', specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/b.js\nTest: proves the second' }),
    cellItem(board, { lane: 'core', title: 'third', criterion: 'three', route: 'mid', check: 'true', brief: 'Files: src/c.js\nTest: proves the third' }),
  ];
  seen.filed = filed.map(item => [item.item_id, item.item_state, item.item_title, item.item_lane]);
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: POLICY }), digest: `digest:${item.item_title}` });
  const claim = (id, seat) => store.claim(board, id, { agentId: seat.id, lane: 'core', leaseMs: 7_200_000, freeze });
  tick(1);
  claim(filed[0].item_id, builder);
  seen.doubleClaim = refusal(() => claim(filed[0].item_id, other));
  submitFixture(board, filed[0].item_id, { agentId: builder.id, commit: COMMIT, tree: COMMIT });
  tick(2);
  const verdict = id => ({ agentId: other.id, head: COMMIT, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any', note: 'proof' });
  seen.selfVerify = refusal(() => store.verify(board, filed[0].item_id, { ...verdict(filed[0].item_id), agentId: builder.id, decision: 'ACCEPT' }));
  store.verify(board, filed[0].item_id, { ...verdict(filed[0].item_id), decision: 'ACCEPT' });
  tick(3);
  claim(filed[1].item_id, builder);
  submitFixture(board, filed[1].item_id, { agentId: builder.id, commit: COMMIT, tree: COMMIT });
  store.verify(board, filed[1].item_id, { ...verdict(filed[1].item_id), decision: 'REJECT', reason: 'OTHER', clause: 'two' });
  seen.missingItem = refusal(() => claim(9999, builder));
  seen.items = filed.map(item => store.getItem(board, item.item_id));
  seen.events = store.events(board);
  seen.lineSettings = store.lineSettings(board);
  seen.agents = [builder, other].map(seat => store.agentById(board, seat.id));
  seen.tables = dump(board.db);
  return seen;
}

/** Every table's rows in insertion order plus the schema, with the one value a board makes at random blanked. */
function dump(db) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = { version: db.prepare('PRAGMA user_version').get().user_version, schema: tables.map(row => row.sql), rows: {} };
  for (const { name } of tables) {
    out.rows[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()
      .map(row => name === 'board_meta' && row.meta_key === 'board_id' ? { ...row, meta_value: '<random>' } : row);
  }
  return out;
}

test('store.stand-in.board-parity: [C7] the same writes and reads give the same tables, rows, events and refusal codes on an in-memory board as on an on-disk one', t => {
  const repo = temporaryRepository(t, 'pullboard-board-contract-');
  mkdirSync(join(repo, '.git', 'pullboard'));
  const disk = script(open(t, 'disk', repo));
  const memory = script(open(t, 'memory', repo));
  assert.ok(disk.events.length > 10, 'the script wrote real events');
  assert.ok(Object.values(disk.tables.rows).some(rows => rows.length), 'tables hold rows');
  assert.deepEqual(disk.doubleClaim, memory.doubleClaim);
  assert.notEqual(disk.doubleClaim, null, 'a second claim is refused on both');
  assert.notEqual(disk.selfVerify, null, 'a builder verifying its own work is refused on both');
  for (const key of ['filed', 'missingItem', 'items', 'events', 'lineSettings', 'agents']) assert.deepEqual(memory[key], disk[key], key);
  assert.deepEqual(memory.tables.schema, disk.tables.schema, 'the same schema');
  assert.equal(memory.tables.version, disk.tables.version);
  for (const name of Object.keys(disk.tables.rows)) assert.deepEqual(memory.tables.rows[name], disk.tables.rows[name], `table ${name}`);
});
