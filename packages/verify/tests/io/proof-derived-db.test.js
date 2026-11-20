/** By default proof counters are written to a derived database beside the board, and read back equal to what board_meta holds with PULLBOARD_PROOF_DERIVED_DB=0 [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { test } from 'node:test';
import { derivedProofCounter } from '../../src/io/proof/counters.js';
import { proofCounter } from '../../src/io/proof/counters.js';
import { rebuildProofCounters } from '../../src/io/proof/counters.js';
import { PROOF_COUNTER_PREFIX } from '../../src/io/proof/counters.js';
import { DERIVED_SETTING } from '../../src/io/proof/derived.js';
import { derivedPath } from '../../src/io/proof/derived.js';
import { derivedRows } from '../../src/io/proof/derived.js';
import { writeDerived } from '../../src/io/proof/derived.js';

/** A file-backed board with a few items' events, the setting on, and the rebuilt counters; closed and cleaned after the test. */
function recorded(t, setting = '1') {
  const dir = privateFixtureFiles('pullboard-derived-').root;
  const file = join(dir, 'board.sqlite');
  const previous = process.env[DERIVED_SETTING];
  if (setting === '1') delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = '0';
  const db = new DatabaseSync(file);
  t.after(() => {
    if (previous === undefined) delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = previous;
    db.close();
  });
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  db.exec('CREATE TABLE event(event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const put = (kind, by, id, detail) => { clock += 37_000; insert.run(new Date(clock).toISOString(), by, kind, id, JSON.stringify(detail)); };
  for (let item = 1; item <= 6; item++) {
    const commit = item.toString(16).padStart(8, '0').repeat(5);
    put('add', 'coordinator', item, { lane: 'core', after: [] });
    put('claim', `agent-${item}`, item, { leaseUntil: new Date(clock + 3_600_000).toISOString() });
    put('submit', `agent-${item}`, item, { commit });
    put('accept', 'rev-1', item, { commit });
    put('merged', 'board', item, {});
  }
  const board = { db, runtimePorts: { verification: { appendRigorCounter() {}, ensureRigorCounters() {} } } };
  rebuildProofCounters(board, { refresh: false });
  return { board, file };
}

test('verify.proof.derived-default: clause 1: recording events with the variable unset writes each v2 proof counter to a derived database beside the board [C7]', t => {
  const { board, file } = recorded(t);
  const meta = board.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key GLOB ?').all(`${PROOF_COUNTER_PREFIX}*`);
  assert.deepEqual(meta, [], 'by default board_meta holds no proof counter [C7]');
  const keys = derivedRows(board).map(row => row.meta_key);
  assert.ok(keys.length > 20, 'the events left proof counters in the derived database');
  const beside = new DatabaseSync(derivedPath(file), { readOnly: true });
  try { assert.equal(beside.prepare('SELECT count(*) AS n FROM proof_counter').get().n, keys.length, 'the file beside the board holds them'); }
  finally { beside.close(); }
});

test('verify.proof.derived-totals: clause 2: proof stats read from the derived database with the variable unset give the same totals as board_meta does with it 0 [C7]', t => {
  const { board } = recorded(t);
  const { board: plain } = recorded(t, 'off');
  delete process.env[DERIVED_SETTING];
  const meta = plain.db.prepare('SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY meta_key').all(`${PROOF_COUNTER_PREFIX}v2:*`);
  assert.deepEqual(derivedRows(board), meta, 'every row is byte-equal');
  const summary = proofCounter(board, 'summary');
  assert.equal(summary.last, 30);
  assert.deepEqual(derivedProofCounter(board, 'summary'), summary, 'the summary totals match');
  assert.deepEqual(derivedProofCounter(board, 'item:3'), proofCounter(board, 'item:3'));
});

test('verify.proof.derived-memory-board: clause 3: an in-memory board has no file for a derived database and keeps its rows in board_meta [C7]', t => {
  const { board } = recorded(t);
  const bare = { db: new DatabaseSync(':memory:'), runtimePorts: board.runtimePorts };
  t.after(() => bare.db.close());
  bare.db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  bare.db.exec('CREATE TABLE event(event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  bare.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)').run('2026-10-01T00:00:37.000Z', 'coordinator', 'add', 1, JSON.stringify({ lane: 'core', after: [] }));
  rebuildProofCounters(bare, { refresh: false });
  assert.deepEqual(derivedRows(bare), []);
  assert.equal(derivedProofCounter(bare, 'summary'), null);
  assert.ok(bare.db.prepare('SELECT count(*) AS n FROM board_meta WHERE meta_key GLOB ?').get(`${PROOF_COUNTER_PREFIX}v2:*`).n > 0, 'board_meta holds the counters');
});

test('verify.proof.derived-off: clause 1: with the setting 0 on a file board no derived database is made and board_meta keeps the rows [C7]', t => {
  const { board, file } = recorded(t, 'off');
  assert.deepEqual(derivedRows(board), []);
  assert.ok(board.db.prepare('SELECT count(*) AS n FROM board_meta WHERE meta_key GLOB ?').get(`${PROOF_COUNTER_PREFIX}v2:*`).n > 20);
  assert.equal(existsSync(derivedPath(file)), false, 'no file beside the board');
});

test('verify.proof.derived-prepare-once: clause 1: writeDerived prepares its upsert once per board connection, not once per call [C7,#9020]', t => {
  const dir = privateFixtureFiles('pullboard-derived-').root;
  const process_previous = process.env[DERIVED_SETTING];
  delete process.env[DERIVED_SETTING];
  const board = { db: new DatabaseSync(join(dir, 'board.sqlite')) };
  t.after(() => {
    if (process_previous === undefined) delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = process_previous;
    board.db.close();
  });
  const upserts = [];
  const real = board.db.prepare.bind(board.db);
  board.db.prepare = sql => { if (/INSERT INTO proof_derived/.test(sql)) upserts.push(sql); return real(sql); };
  for (let call = 0; call < 50; call++) writeDerived(board, [`k:${call}`, 'a', `j:${call}`, 'b']);
  assert.equal(upserts.length, 1, 'fifty calls prepared the upsert once');
  assert.equal(derivedRows(board).filter(row => /^[kj]:/.test(row.meta_key)).length, 100, 'every pair was written');
});
