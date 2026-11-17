/** @pullboard-test-input source-cell packages/verify */
/** With PULLBOARD_PROOF_DERIVED_DB on, proof stats live in the derived database only, and a missing derived file is rebuilt from events with the same totals [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { PROOF_COUNTER_PREFIX } from '../../../verify/index.js';
import { ensureProofCounters } from '../../../verify/index.js';
import { proofCounter } from '../../../verify/index.js';
import { proofCounterRows } from '../../../verify/index.js';
import { rebuildProofCounters } from '../../../verify/index.js';

const SETTING = 'PULLBOARD_PROOF_DERIVED_DB';
const PORTS = { verification: { appendRigorCounter() {}, ensureRigorCounters() {} } };

/** A file-backed board with a few items' events and counters rebuilt, with the derived setting on; the setting is restored after the test. */
function recorded(t) {
  const file = join(privateFixtureFiles('pullboard-derived-rebuild-').root, 'board.sqlite');
  const previous = process.env[SETTING];
  process.env[SETTING] = '1';
  const open = () => new DatabaseSync(file);
  const db = open();
  t.after(() => {
    if (previous === undefined) delete process.env[SETTING]; else process.env[SETTING] = previous;
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
  const board = { db, runtimePorts: PORTS };
  rebuildProofCounters(board, { refresh: false });
  return { board, file, open };
}

/** The totals proof stats read: the summary and every event row. */
const totals = board => ({ summary: proofCounter(board, 'summary'), events: proofCounterRows(board, 'event') });

test('clause 1: after recording events board_meta has no local:proof-stats rows [C7]', t => {
  const { board } = recorded(t);
  assert.deepEqual(board.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key GLOB ?').all(`${PROOF_COUNTER_PREFIX}*`), []);
  board.db.close();
});

test('clause 2: proof stats read the same totals from the derived database [C7]', t => {
  const { board } = recorded(t);
  const read = totals(board);
  assert.equal(read.summary.last, 18);
  assert.equal(read.events.length, 18);
  board.db.close();
});

test('clause 3: deleting the derived database file then reading proof stats rebuilds the same totals from events [C7]', t => {
  const { board, file, open } = recorded(t);
  const before = totals(board);
  board.db.close();
  const derived = `${file}.proof-derived.sqlite`;
  assert.ok(existsSync(derived), 'the derived file exists beside the board');
  rmSync(derived);
  const reopened = { db: open(), runtimePorts: PORTS };
  ensureProofCounters(reopened, { refresh: false });
  assert.ok(existsSync(derived), 'the read recreated the derived file');
  assert.deepEqual(totals(reopened), before, 'the rebuilt totals equal the recorded ones');
  assert.deepEqual(reopened.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key GLOB ?').all(`${PROOF_COUNTER_PREFIX}*`), [], 'and board_meta stayed empty of them');
  reopened.db.close();
});
