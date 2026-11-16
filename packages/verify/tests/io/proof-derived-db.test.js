/** Proof counters are also written to a derived database beside the board, and read back equal to board_meta [C7]. */
import assert from 'node:assert/strict';
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
function recorded(t) {
  const dir = privateFixtureFiles('pullboard-derived-').root;
  const file = join(dir, 'board.sqlite');
  const previous = process.env[DERIVED_SETTING];
  process.env[DERIVED_SETTING] = '1';
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

test('clause 1: recording events writes each v2 proof counter to a derived database beside the board [C7]', t => {
  const { board, file } = recorded(t);
  const meta = board.db.prepare('SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY meta_key').all(`${PROOF_COUNTER_PREFIX}v2:*`);
  assert.ok(meta.length > 20, 'the events left proof counters in board_meta');
  assert.deepEqual(derivedRows(board).map(row => row.meta_key), meta.map(row => row.meta_key), 'every counter key is in the derived database');
  const beside = new DatabaseSync(derivedPath(file), { readOnly: true });
  try { assert.equal(beside.prepare('SELECT count(*) AS n FROM proof_counter').get().n, meta.length, 'the file beside the board holds them'); }
  finally { beside.close(); }
});

test('clause 2: proof stats read from the derived database give the same totals as board_meta [C7]', t => {
  const { board } = recorded(t);
  const meta = board.db.prepare('SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY meta_key').all(`${PROOF_COUNTER_PREFIX}v2:*`);
  assert.deepEqual(derivedRows(board), meta, 'every row is byte-equal');
  const summary = proofCounter(board, 'summary');
  assert.equal(summary.last, 30);
  assert.deepEqual(derivedProofCounter(board, 'summary'), summary, 'the summary totals match');
  assert.deepEqual(derivedProofCounter(board, 'item:3'), proofCounter(board, 'item:3'));
});

test('clause 1: with the setting off no derived database is made [C7]', t => {
  const { board, file } = recorded(t);
  delete process.env[DERIVED_SETTING];
  const bare = { ...board, db: new DatabaseSync(':memory:') };
  t.after(() => bare.db.close());
  assert.deepEqual(derivedRows(bare), []);
  assert.equal(derivedProofCounter(bare, 'summary'), null);
  assert.ok(file);
});

test('clause 1: writeDerived prepares its upsert once per board connection, not once per call [C7,#9020]', t => {
  const dir = privateFixtureFiles('pullboard-derived-').root;
  const process_previous = process.env[DERIVED_SETTING];
  process.env[DERIVED_SETTING] = '1';
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

test('clause 1: a replay commits once per batch of events, not once per write [C7,#9020]', t => {
  const { board } = recorded(t);
  const statements = [];
  const real = board.db.exec.bind(board.db);
  board.db.exec = sql => { if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) statements.push(sql); return real(sql); };
  rebuildProofCounters(board, { refresh: false });
  const commits = statements.filter(sql => sql === 'COMMIT').length;
  assert.ok(commits >= 1 && commits <= 2, `30 events replay in at most two transactions, saw ${commits}`);
  assert.equal(statements.filter(sql => sql === 'BEGIN').length, commits, 'every transaction began once and committed once');
  assert.equal(statements.includes('ROLLBACK'), false);
});

test('clause 2: derived counters equal board_meta counters after a replay of several batches [C7,#9020]', t => {
  const { board } = recorded(t);
  const insert = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  board.db.exec('BEGIN');
  for (let n = 0; n < 600; n++) insert.run(new Date(Date.parse('2026-11-01T00:00:00Z') + n * 1000).toISOString(), `agent-${n % 7}`, 'submit', 100 + n % 50, JSON.stringify({ commit: String(n).padStart(40, '0') }));
  board.db.exec('COMMIT');
  rebuildProofCounters(board, { refresh: false });
  const meta = board.db.prepare('SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY meta_key').all(`${PROOF_COUNTER_PREFIX}v2:*`);
  assert.deepEqual(derivedRows(board), meta, 'every row is byte-equal after three batches');
  assert.equal(proofCounter(board, 'summary').last, 630);
});
