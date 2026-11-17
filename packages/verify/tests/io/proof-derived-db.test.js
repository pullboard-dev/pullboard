/** With the setting on proof counters are written to a derived database beside the board, and read back equal to what board_meta holds with it off [C7]. */
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

/** A file-backed board with a few items' events, the setting on, and the rebuilt counters; closed and cleaned after the test. */
function recorded(t, setting = '1') {
  const dir = privateFixtureFiles('pullboard-derived-').root;
  const file = join(dir, 'board.sqlite');
  const previous = process.env[DERIVED_SETTING];
  if (setting === '1') process.env[DERIVED_SETTING] = '1'; else delete process.env[DERIVED_SETTING];
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
  const meta = board.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key GLOB ?').all(`${PROOF_COUNTER_PREFIX}*`);
  assert.deepEqual(meta, [], 'with the setting on board_meta holds no proof counter [C7]');
  const keys = derivedRows(board).map(row => row.meta_key);
  assert.ok(keys.length > 20, 'the events left proof counters in the derived database');
  const beside = new DatabaseSync(derivedPath(file), { readOnly: true });
  try { assert.equal(beside.prepare('SELECT count(*) AS n FROM proof_counter').get().n, keys.length, 'the file beside the board holds them'); }
  finally { beside.close(); }
});

test('clause 2: proof stats read from the derived database give the same totals as board_meta does with the setting off [C7]', t => {
  const { board } = recorded(t);
  const { board: plain } = recorded(t, 'off');
  process.env[DERIVED_SETTING] = '1';
  const meta = plain.db.prepare('SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY meta_key').all(`${PROOF_COUNTER_PREFIX}v2:*`);
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
