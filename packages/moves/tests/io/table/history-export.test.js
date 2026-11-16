/** The read-only exporter writes scrubbed landing and verify history from a board, each decision with its derived landing value [M1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { exportTableHistory } from '../../../index.js';
import { readLandingMoveRecords } from '../../../index.js';
import { readVerifyRecords } from '../../../index.js';

const files = privateFixtureFiles('pullboard-history-export-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const HOME = '/Users/somebody';
const SINCE = '2026-11-05T00:00:00.000Z';
const BATCH = (state, merge) => ({ id: 'b1', startedAt: '2026-11-10T03:00:00.000Z', base: 'a'.repeat(40), state,
  candidates: [{ id: 1, commit: 'c'.repeat(40) }], items: [{ id: 1, commit: 'c'.repeat(40), ...(merge ? { merge } : {}) }] });

/** A fixture board on real SQLite with the tables both readers SELECT from, one item landed through a batch and one rejected; removed after the test. */
function board() {
  const file = join(files.root, 'board.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_route TEXT);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_frozen TEXT, item_frozen_digest TEXT, item_lane TEXT);
    CREATE TABLE verdict (verdict_id INTEGER PRIMARY KEY, item_id INTEGER, verdict_by TEXT, verdict_decision TEXT, verdict_reason TEXT, verdict_note TEXT, verdict_commit TEXT,
      verdict_digest TEXT, verdict_head TEXT, verdict_verifier_family TEXT, verdict_at TEXT);
    CREATE TABLE shout (shout_id INTEGER PRIMARY KEY, shout_to TEXT, shout_text TEXT, shout_decision INTEGER);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)`);
  const add = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const at = (hour) => `2026-11-10T${String(hour).padStart(2, '0')}:00:00.000Z`;
  add.run('2026-11-01T00:00:00.000Z', 'coordinator', 'add', 1, JSON.stringify({ after: [], lane: 'core' }));
  add.run('2026-11-01T00:00:00.000Z', 'coordinator', 'add', 2, JSON.stringify({ after: [], lane: 'core' }));
  add.run(at(0), 'core-1', 'claim', 1, JSON.stringify({ worktree: `${HOME}/seat/item-1` }));
  add.run(at(1), 'core-1', 'submit', 1, JSON.stringify({ commit: 'c'.repeat(40) }));
  add.run(at(2), 'core-2', 'accept', 1, JSON.stringify({ commit: 'c'.repeat(40) }));
  add.run(at(3), 'coordinator', 'landing_batch', null, JSON.stringify({ batch: BATCH('selected') }));
  add.run(at(4), 'coordinator', 'landing_batch', null, JSON.stringify({ batch: BATCH('pushed', 'd'.repeat(40)) }));
  add.run(at(5), 'coordinator', 'merged', 1, JSON.stringify({ commit: 'd'.repeat(40) }));
  add.run(at(5), 'coordinator', 'main-moved', null, JSON.stringify({ sha: 'd'.repeat(40), batch: 'b1', items: [1] }));
  add.run(at(6), 'core-1', 'claim', 2, '{}');
  add.run(at(7), 'core-1', 'submit', 2, JSON.stringify({ commit: 'e'.repeat(40) }));
  add.run(at(8), 'core-2', 'reject', 2, JSON.stringify({ commit: 'e'.repeat(40), note: `see /home/other/log.txt and ${HOME}/x` }));
  db.prepare('INSERT INTO agent VALUES (?, ?)').run('core-2', 'mid');
  db.prepare('INSERT INTO item VALUES (?, ?, ?, ?)').run(1, JSON.stringify({ title: 'one', criterion: '1. lands [test]' }), null, 'core');
  db.prepare('INSERT INTO item VALUES (?, ?, ?, ?)').run(2, JSON.stringify({ title: 'two', criterion: `1. reads ${HOME}/notes [test]` }), null, 'core');
  db.prepare('INSERT INTO verdict VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1, 'core-2', 'ACCEPT', null, null, 'c'.repeat(40), null, null, null, at(2));
  db.prepare('INSERT INTO verdict VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(2, 2, 'core-2', 'REJECT', 'BEHAVIOR_MISMATCH', 'no', 'e'.repeat(40), null, null, null, at(8));
  db.close();
  return file;
}

const file = board();
const before = readFileSync(file);
const exported = exportTableHistory(file, { since: SINCE, home: HOME });

/** The exported document's rows on an in-memory board, as a replay fixture loads them. */
function reloaded(document, tables) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_route TEXT);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_frozen TEXT, item_frozen_digest TEXT, item_lane TEXT);
    CREATE TABLE verdict (verdict_id INTEGER PRIMARY KEY, item_id INTEGER, verdict_by TEXT, verdict_decision TEXT, verdict_reason TEXT, verdict_note TEXT, verdict_commit TEXT,
      verdict_digest TEXT, verdict_head TEXT, verdict_verifier_family TEXT, verdict_at TEXT);
    CREATE TABLE shout (shout_id INTEGER PRIMARY KEY, shout_to TEXT, shout_text TEXT, shout_decision INTEGER);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)`);
  for (const [table, key] of tables) {
    for (const row of document[key]) db.prepare(`INSERT INTO ${table} VALUES (${row.map(() => '?').join(',')})`).run(...row.map(value => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value)));
  }
  return { db };
}

test('clause 1: landing history exported through readLandingMoveRecords has one record per landing decision, each with its derived landing value [M1]', () => {
  const records = readLandingMoveRecords(file, { since: SINCE });
  const tables = ['select', 'selection', 'record', 'merged', 'outcome'];
  assert.equal(exported.landing.decisions.length, tables.reduce((sum, table) => sum + records[table].length, 0), 'one decision per rebuilt record');
  assert.deepEqual(exported.landing.decisions.map(entry => [entry.table, entry.event]), tables.flatMap(table => records[table].map(record => [table, record.event.id])));
  assert.ok(exported.landing.decisions.some(entry => entry.table === 'record'), 'the batch landing is a decision');
  const select = exported.landing.decisions.find(entry => entry.table === 'select');
  assert.equal(select.landing, 'none', 'item 1 was not landed when the lander chose it');
  const record = exported.landing.decisions.find(entry => entry.table === 'record');
  assert.deepEqual(record.landing, { 1: 'none' }, 'the record decision saw the batch item before its merge');
  for (const entry of exported.landing.decisions) {
    const values = typeof entry.landing === 'string' ? [entry.landing] : Object.values(entry.landing);
    assert.ok(values.every(value => ['none', 'landed', 'pulling', 'published'].includes(value)), `event ${entry.event} carries a landing value`);
  }
  const again = readLandingMoveRecords(reloaded(exported.landing, [['event', 'events']]), { since: SINCE });
  assert.deepEqual(tables.map(table => again[table].length), tables.map(table => records[table].length), 'the exported rows rebuild the same decisions');
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, 'the board file is unchanged');
});

test('clause 2: verify history is exported through readVerifyRecords from the same board [M1]', () => {
  const records = readVerifyRecords(file, { since: SINCE });
  assert.deepEqual(exported.verify.decisions.map(entry => entry.event), records.verify.map(record => record.event.id));
  assert.deepEqual(exported.verify.verdicts, [5, 12], 'both verdicts in the window');
  assert.deepEqual(exported.verify.decisions.map(entry => entry.landing), ['none', 'none'], 'neither item was landed when its verdict was given');
  const again = readVerifyRecords(reloaded(exported.verify, [['event', 'events'], ['agent', 'agents'], ['item', 'items'], ['verdict', 'verdictRows'], ['shout', 'shouts'], ['board_meta', 'meta']]), { since: SINCE });
  assert.deepEqual(again.verify.map(record => [record.event.id, record.move.decision ?? record.move.name]), records.verify.map(record => [record.event.id, record.move.decision ?? record.move.name]),
    'the exported rows rebuild the same verdicts');
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, 'the board file is unchanged');
});

test('clause 3: neither exported document holds a home-directory path [M1]', () => {
  for (const [name, document] of Object.entries(exported)) {
    const text = JSON.stringify(document);
    assert.ok(!text.includes(HOME), `${name} names no person's home`);
    assert.doesNotMatch(text, /\/(?:Users|home)\/[^/\s"\\]+/u, `${name} names no home folder at all`);
  }
  assert.match(JSON.stringify(exported.landing), /~\/seat\/item-1/u, 'the scrub keeps the path below home');
  assert.match(JSON.stringify(exported.verify), /see ~\/log\.txt and ~\/x/u);
});
