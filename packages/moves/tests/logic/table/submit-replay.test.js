/** @pullboard-world-pin reads the recorded submit history fixture to replay it through the tables. The submit tables replay the submit-family writes recorded on a real board with zero disagreements, and refuse what the board refuses [C7,#8247]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { boardSubmitEngine } from '../../../index.js';
import { readSubmitRecords } from '../../../index.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';
import { SUBMIT_COMMAND_NEXT } from '../../../index.js';
import { submitEngine } from '../../../index.js';
import submit from '../../../src/logic/moves/submit.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/submit-history.json', import.meta.url), 'utf8'));
const ENGINE = boardSubmitEngine();

/** The recorded events, seats, shouts and gate job records on an in-memory board, shaped as the real board stores them. */
function recordedBoard() {
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
  return { db };
}

const { records, unreplayable } = readSubmitRecords(recordedBoard(), { since: HISTORY.since });
const byTable = (name) => records.filter(record => record.table === name);
const replay = (name, list = byTable(name)) => replayTable(ENGINE.tables[name], ENGINE.rules, list, { cut: HISTORY.since });

test('clause 1: replaying recorded board history through the submit tables gives zero disagreements [C7,#8247]', () => {
  const counts = {};
  for (const name of ['SUBMIT', 'COMMIT', 'START', 'COMPLETE']) {
    const report = replay(name);
    assert.deepEqual(report.disagreements, [], name);
    assert.deepEqual([report.total, report.agreed, report.notReplayable], [byTable(name).length, byTable(name).length, 0], name);
    counts[name] = report.agreed;
  }
  assert.deepEqual(unreplayable, []);
  assert.equal(byTable('OUTCOME').length, 2);
  for (const record of byTable('OUTCOME')) {
    const answer = runTable(ENGINE.tables.OUTCOME, ENGINE.rules, structuredClone(record.snapshot), structuredClone(record.move));
    assert.equal(answer.via[0], 'renew');
    assert.deepEqual(JSON.parse(JSON.stringify(ENGINE.tables.OUTCOME.outcomes.find(o => o.id === 'renew').submitOutcome(record.snapshot, record.move))), record.renewal);
  }
  assert.deepEqual(counts, EXPECTED_COUNTS);
});

test('clause 1: every recorded write took the path the table chose [C7,#8247]', () => {
  for (const record of records.filter(entry => entry.table !== 'OUTCOME')) {
    const answer = runTable(ENGINE.tables[record.table], ENGINE.rules, structuredClone(record.snapshot), structuredClone(record.move));
    assert.equal(answer.via?.[0], record.via, `${record.table} ${record.path} at event ${record.event.id}`);
  }
});

test('clause 1: the replay covers every submit path the board used, commits and hand-offs included [C7,#8247]', () => {
  const paths = new Set(records.map(record => `${record.table}: ${record.via}`));
  for (const path of EXPECTED_PATHS) assert.ok(paths.has(path), `${path} replayed`);
});

test('clause 1: a recorded submit replayed with one captured fact broken is a disagreement the replay names [C7,#8247]', () => {
  const commit = byTable('COMMIT')[0];
  const stranger = { ...structuredClone(commit), move: { ...structuredClone(commit.move), actor: 'someone-else' } };
  assert.deepEqual(replay('COMMIT', [stranger]).disagreements.map(entry => [entry.event, entry.table.code]), [[commit.event.id, 'NOT_YOURS']]);
  const queue = byTable('SUBMIT')[0];
  const moved = { ...structuredClone(queue), snapshot: { ...structuredClone(queue.snapshot), item: { ...structuredClone(queue.snapshot.item), status: 'open' } } };
  assert.deepEqual(replay('SUBMIT', [moved]).disagreements.map(entry => entry.table.code), ['NOT_YOURS']);
});

test('clause 1: the submit table refuses with its words, and the command reads its next steps from the table [C7,#8247]', () => {
  const record = byTable('SUBMIT')[0];
  const refuse = (snapshot) => runTable(ENGINE.tables.SUBMIT, ENGINE.rules, structuredClone(snapshot), structuredClone(record.move)).refused;
  const none = refuse({ ...record.snapshot, item: null });
  assert.deepEqual([none.code, none.message, none.next, none.row], ['NO_ITEM', `no item #${record.move.id}; see: pullboard list`, 'find the item id: pullboard list --all', 'item-exists']);
  const stranger = refuse({ ...record.snapshot, item: { ...record.snapshot.item, owner: 'someone-else' } });
  assert.deepEqual([stranger.code, stranger.row], ['NOT_YOURS', 'holder']);
  for (const [code, next] of Object.entries(SUBMIT_COMMAND_NEXT)) assert.equal(submit.nextSteps[code], next, code);
  assert.throws(() => submitEngine({ retryLimit: 0, infrastructureCodes: [] }), { code: 'SUBMIT_TABLE_INPUTS' });
});

/** The recorded writes this fixture holds, per table, and the paths they took. */
const EXPECTED_COUNTS = { SUBMIT: 7, COMMIT: 6, START: 15, COMPLETE: 13 };
const EXPECTED_PATHS = ['SUBMIT: queue', 'COMMIT: submit', 'START: start', 'START: retry', 'COMPLETE: green', 'COMPLETE: infrastructure', 'COMPLETE: red-to-builder'];
