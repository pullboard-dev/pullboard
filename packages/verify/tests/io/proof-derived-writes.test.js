/** @pullboard-test-input source-cell packages/verify */
/** With PULLBOARD_PROOF_DERIVED_DB on, proof counter writes and clears touch the derived database only; off, board_meta as today [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { test } from 'node:test';
import { clearProofCounters } from '../../src/io/proof/counters.js';
import { proofCounter } from '../../src/io/proof/counters.js';
import { rebuildProofCounters } from '../../src/io/proof/counters.js';
import { PROOF_COUNTER_PREFIX } from '../../src/io/proof/counters.js';
import { DERIVED_SETTING } from '../../src/io/proof/derived.js';
import { derivedRows } from '../../src/io/proof/derived.js';

/** A file-backed board with a few items' events and counters rebuilt under the given setting; the setting is restored after the test. */
function recorded(t, setting) {
  const dir = privateFixtureFiles('pullboard-derived-writes-').root;
  const previous = process.env[DERIVED_SETTING];
  if (setting === '1') process.env[DERIVED_SETTING] = '1'; else delete process.env[DERIVED_SETTING];
  const db = new DatabaseSync(join(dir, 'board.sqlite'));
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
    put('add', 'coordinator', item, { lane: 'core', after: [] });
    put('claim', `agent-${item}`, item, { leaseUntil: new Date(clock + 3_600_000).toISOString() });
    put('submit', `agent-${item}`, item, { commit: item.toString(16).padStart(8, '0').repeat(5) });
  }
  const board = { db, runtimePorts: { verification: { appendRigorCounter() {}, ensureRigorCounters() {} } } };
  rebuildProofCounters(board, { refresh: false });
  return board;
}

const metaRows = board => board.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key GLOB ?').all(`${PROOF_COUNTER_PREFIX}*`);

test('clause 1: with PULLBOARD_PROOF_DERIVED_DB=1, after recording events board_meta holds no local:proof-stats row [C7]', t => {
  const board = recorded(t, '1');
  assert.deepEqual(metaRows(board), [], 'board_meta has no proof counter row');
  assert.ok(derivedRows(board).length > 20, 'the derived database holds them');
  assert.equal(proofCounter(board, 'summary').last, 18, 'and the counters still read back');
});

test('clause 2: clearProofCounters and the hot flush delete and write the derived database only [C7]', t => {
  const board = recorded(t, '1');
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`${PROOF_COUNTER_PREFIX}v2:marker`, 'x');
  const before = derivedRows(board).length;
  clearProofCounters(board);
  assert.deepEqual(metaRows(board).map(row => row.meta_key), [`${PROOF_COUNTER_PREFIX}v2:marker`], 'the clear never touched board_meta');
  assert.ok(derivedRows(board).length < before, 'the clear emptied the derived rows');
  rebuildProofCounters(board, { refresh: false });
  assert.deepEqual(metaRows(board).map(row => row.meta_key), [`${PROOF_COUNTER_PREFIX}v2:marker`], 'the rebuild flush wrote no board_meta row');
  assert.equal(proofCounter(board, 'summary').last, 18);
});

test('clause 2: with the setting off the same events leave their counters in board_meta and no derived rows [C7]', t => {
  const board = recorded(t, 'off');
  assert.ok(metaRows(board).length > 20);
  assert.deepEqual(derivedRows(board), []);
});
