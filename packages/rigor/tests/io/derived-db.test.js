/** Rigor counters live in the derived database, not board_meta, when the setting is on [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { test } from 'node:test';
import { ensureRigorCounters } from '../../src/io/counters.js';
import { resumeRigorCounters } from '../../src/io/counters.js';
import { RIGOR_DERIVED_SETTING as DERIVED_SETTING } from '../../src/io/derived.js';
import { rigorDerived } from '../../src/io/derived.js';

const PREFIX = 'local:proof-stats:rigor:v1:';

/** Every rigor counter row in the derived database, by key; empty when the setting is off. */
function derivedRows(board) {
  const schema = rigorDerived(board);
  return schema ? board.db.prepare(`SELECT meta_key FROM ${schema}.rigor_counter ORDER BY meta_key`).all() : [];
}

/** A file-backed board whose events repeat two causes across items; the setting is on or off, and counters are built. Closed and restored after the test. */
function recorded(t, setting) {
  const dir = privateFixtureFiles('pullboard-rigor-derived-').root;
  const previous = process.env[DERIVED_SETTING];
  if (setting) process.env[DERIVED_SETTING] = '1'; else delete process.env[DERIVED_SETTING];
  const db = new DatabaseSync(join(dir, 'board.sqlite'));
  t.after(() => {
    if (previous === undefined) delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = previous;
    db.close();
  });
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  db.exec('CREATE TABLE event(event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  let clock = Date.parse('2026-10-01T00:00:00Z');
  for (let item = 1; item <= 4; item++) {
    for (const cause of ['refusal:GATE_RED', `refusal:ONLY_${item}`]) {
      clock += 37_000;
      insert.run(new Date(clock).toISOString(), 'rev-1', 'reject', item, JSON.stringify({ cause, commit: String(item).repeat(40) }));
    }
  }
  const board = { db };
  ensureRigorCounters(board);
  return board;
}

/** The rows the counters left in board_meta. */
function metaRows(board) {
  return board.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key GLOB ?').all(`${PREFIX}*`);
}

test('clause 1: with the setting on, recording events leaves no rigor counter rows in board_meta [C7]', t => {
  const board = recorded(t, true);
  assert.deepEqual(metaRows(board), [], 'board_meta holds no rigor rows');
  const derived = derivedRows(board);
  assert.ok(derived.length > 8, 'the derived database holds the counters');
});

test('clause 2: rigor counters read the same per-cause totals from the derived database as from board_meta [C7]', t => {
  const state = { spec: [], practice: [] };
  const fromMeta = resumeRigorCounters(recorded(t, false), state);
  const board = recorded(t, true);
  const fromDerived = resumeRigorCounters(board, state);
  assert.ok(fromDerived.causes.length >= 1, 'the repeated cause is reported');
  assert.equal(fromDerived.causes[0].key, 'refusal:GATE_RED');
  assert.deepEqual(fromDerived, fromMeta, 'identical totals');
  assert.deepEqual(metaRows(board), []);
});

test('clause 3: with the setting off, rigor counters stay in board_meta and no derived file is made [C7]', t => {
  const board = recorded(t, false);
  assert.ok(metaRows(board).length > 8, 'board_meta holds the counters');
  assert.deepEqual(derivedRows(board), []);
});
