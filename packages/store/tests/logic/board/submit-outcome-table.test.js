/** @pullboard-world-pin reads the recorded submit history fixture to drive the submit outcome writer with it. The store submit writer applies the submit table and agrees on every replayed move [C7,#8271].
 * @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/src/io/submit/outcome.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readSubmitRecords } from '../../../../moves/index.js';
import { checkedSubmitOutcome } from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../../../moves/tests/fixtures/table/submit-history.json', import.meta.url), 'utf8'));
const STAMP = '2026-01-01T00:00:00.000Z';

/** The recorded events on a scratch in-memory board, read the way the replay reads them. */
function recorded() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_lane TEXT, agent_route TEXT);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_parent_id INTEGER);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT);
    CREATE TABLE shout (shout_id INTEGER PRIMARY KEY, shout_from TEXT, shout_to TEXT, shout_text TEXT);
    CREATE TABLE job (job_id INTEGER PRIMARY KEY, job_kind TEXT, job_item INTEGER);
    CREATE TABLE job_step (job_step_id INTEGER PRIMARY KEY, job_step_job INTEGER, job_step_payload TEXT)`);
  const insert = (sql, rows) => { const statement = db.prepare(sql); for (const row of rows) statement.run(...row); };
  insert('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)', HISTORY.events.map(([id, at, by, kind, item, detail]) => [id, at, by, kind, item, JSON.stringify(detail)]));
  insert('INSERT INTO agent VALUES (?, ?, ?)', HISTORY.agents);
  insert('INSERT INTO item VALUES (?, ?)', HISTORY.parents);
  insert('INSERT INTO board_meta VALUES (?, ?)', HISTORY.outside);
  insert('INSERT INTO shout VALUES (?, ?, ?, ?)', HISTORY.shouts);
  insert('INSERT INTO job VALUES (?, ?, ?)', [...new Set(HISTORY.jobSteps.map(([item]) => item))].map(item => [item, 'gate', item]));
  insert('INSERT INTO job_step VALUES (?, ?, ?)', HISTORY.jobSteps.map(([item, payload], i) => [i + 1, item, payload]));
  return readSubmitRecords({ db }, { since: HISTORY.since });
}

/** A real board holding the one item a recorded refusal renewal saw, on a clock at the renewal's own instant. */
function boardFor(t, snapshot, over = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', ?, ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, over.status ?? item.status, over.owner ?? item.owner, over.leaseUntil ?? item.leaseUntil, over.digest ?? item.frozenDigest, STAMP, STAMP);
  return board;
}

/** Run the writer on a board that shadows it: the table's answer and what the writer did. */
function drive(board, record, value = record.renewal) {
  const seen = [];
  board.submitOutcomeShadow = (answer) => seen.push(answer);
  const { id, actor } = record.move;
  let threw = null;
  let returned;
  try { returned = checkedSubmitOutcome(board, id, actor, value, null); } catch (error) { threw = error; }
  assert.equal(seen.length, 1, 'the writer ran the table once');
  return { seen: seen[0], returned, threw };
}

const { records } = recorded();
const outcomes = records.filter(record => record.table === 'OUTCOME');

test('clause 1: the store submit writer applies the submit table and agrees on every replayed move [C7,#8271]', t => {
  assert.equal(outcomes.length, 2, 'the replay holds the board\'s two refusal renewals');
  for (const record of outcomes) {
    const { seen, returned, threw } = drive(boardFor(t, record.snapshot), record);
    assert.equal(threw, null);
    assert.deepEqual(seen.decided, { recorded: record.renewal }, 'the table records what the board recorded');
    assert.deepEqual(seen.wrote, { recorded: returned }, 'the writer reports what it returned');
    assert.deepEqual(JSON.parse(JSON.stringify(returned)), record.renewal, 'the writer records what the board recorded');
  }
});

test('clause 1: a renewal on a claim that moved on is skipped by the table and refused by the writer [C7,#8271]', t => {
  const [record] = outcomes;
  const moved = { owner: 'someone-else' };
  const expired = { leaseUntil: '2000-01-01T00:00:00.000Z' };
  const rebarred = { digest: 'f'.repeat(64) };
  const released = { status: 'open' };
  for (const over of [moved, expired, rebarred, released]) {
    const { seen, threw } = drive(boardFor(t, record.snapshot, over), record);
    assert.deepEqual(seen.decided, { skipped: true }, JSON.stringify(over));
    assert.equal(threw.code, 'ITEM_LEASE_LOST', JSON.stringify(over));
    assert.deepEqual(seen.wrote.refused.code, 'ITEM_LEASE_LOST');
  }
});

test('clause 1: a malformed refusal is refused by both the table and the writer [C7,#8271]', t => {
  const [record] = outcomes;
  for (const bad of [{ ...record.renewal, code: 'lower' }, { ...record.renewal, text: '   ' }]) {
    const { seen, threw } = drive(boardFor(t, record.snapshot), record, bad);
    assert.equal(seen.decided.refused.code, 'USAGE');
    assert.equal(threw.code, 'USAGE');
  }
});
