/** With PULLBOARD_PROOF_DERIVED_DB on, proof counter reads come from the derived database; off they read board_meta [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { test } from 'node:test';
import { proofCounter } from '../../src/io/proof/counters.js';
import { proofCounterRows } from '../../src/io/proof/counters.js';
import { rebuildProofCounters } from '../../src/io/proof/counters.js';
import { PROOF_COUNTER_PREFIX } from '../../src/io/proof/counters.js';
import { DERIVED_SETTING } from '../../src/io/proof/derived.js';

/** A file-backed board with a few items' events and counters rebuilt under the setting; the setting is restored after the test. */
function recorded(t, setting = '1') {
  const dir = privateFixtureFiles('pullboard-derived-reads-').root;
  const previous = process.env[DERIVED_SETTING];
  if (setting === '1') delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = '0';
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

test('clause 1: with PULLBOARD_PROOF_DERIVED_DB=1 readCounter, proofCounter and proofCounterRows return the derived rows [C7]', t => {
  const board = recorded(t);
  const summary = proofCounter(board, 'summary');
  const events = proofCounterRows(board, 'event');
  assert.equal(summary.last, 18);
  assert.equal(events.length, 18);
  assert.deepEqual(events.map(row => row.item).slice(0, 3), [1, 1, 1], 'numeric id order, not text order');
  // Empty board_meta: only the derived database can still answer.
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PROOF_COUNTER_PREFIX}*`);
  assert.deepEqual(proofCounter(board, 'summary'), summary, 'the point read comes from the derived file');
  assert.deepEqual(proofCounterRows(board, 'event'), events, 'the kind read comes from the derived file');
  // Held reads (inside a replay) take the same source.
  assert.deepEqual(proofCounter(board, 'item:2'), proofCounter(board, 'item:2'));
  assert.notEqual(proofCounter(board, 'item:2'), null);
});

test('clause 2: with the setting off the counters read board_meta exactly as today [C7]', t => {
  const board = recorded(t, 'off');
  const summary = proofCounter(board, 'summary');
  assert.deepEqual(proofCounter(board, 'summary'), summary, 'board_meta still holds the rows');
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PROOF_COUNTER_PREFIX}*`);
  assert.equal(proofCounter(board, 'summary'), null, 'off, an emptied board_meta reads empty');
  assert.deepEqual(proofCounterRows(board, 'event'), []);
});
