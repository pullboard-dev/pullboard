/** @pullboard-world-pin reads the recorded submit history fixture to drive the hand-off writers with it. The store hand-off start and queue writers apply the submit tables and agree on every replayed move [C7,#8279,#8280].
 * @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/src/io/submit/handoff/retry.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readSubmitRecords } from '../../../../moves/index.js';
import { queueSubmitHandoff } from '../../../index.js';
import { startSubmitHandoff } from '../../../index.js';
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

/** A real board holding the one item a recorded move saw and the hand-off record it found, on a clock at the move's own instant. */
function boardFor(t, snapshot, over = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', ?, ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, over.status ?? item.status, over.owner ?? item.owner, over.leaseUntil ?? item.leaseUntil, over.digest ?? item.frozenDigest, STAMP, STAMP);
  if (snapshot.handoff) board.enginePorts.shadowJob(sql, item.id, over.handoff ?? snapshot.handoff, { now: Date.parse(snapshot.now) });
  return board;
}

/** Run a writer on a board that shadows it: the table's answer and what the writer did. */
function drive(board, hook, run) {
  const seen = [];
  board[hook] = (answer) => seen.push(answer);
  run();
  assert.equal(seen.length, 1, 'the writer ran the table once');
  return seen[0];
}

/** The writer's options for a recorded start move. */
const startOptions = ({ actor, job, hook, retryJob, unrecoverable }) => ({ agentId: actor, job, ...(hook ? { hookProjection: hook } : {}), ...(retryJob ? { retryJob } : {}), ...(unrecoverable ? { unrecoverable } : {}) });
/** The writer's options for a recorded queue move: the captured candidate its snapshot held. */
const queueOptions = (record) => { const { head, companionDigest } = record.snapshot.io; const { item } = record.snapshot;
  return { agentId: record.move.actor, job: record.move.job, ...head, digest: item.frozenDigest, companionDigest, leaseMs: record.snapshot.config.leaseMs }; };

const { records } = recorded();
const starts = records.filter(record => record.table === 'START' && !record.move.hook && record.move.unrecoverable === undefined);
const queues = records.filter(record => record.table === 'SUBMIT');

test('clause 1: the store hand-off start writer applies the START table and agrees on every replayed move [C7,#8279]', t => {
  assert.ok(starts.length >= 10, 'the replay holds the board\'s starts and requeues');
  assert.deepEqual([...new Set(starts.map(record => record.via))].sort(), ['retry', 'start']);
  for (const record of starts) {
    const board = boardFor(t, record.snapshot);
    const seen = drive(board, 'startSubmitHandoffShadow', () => startSubmitHandoff(board, record.move.id, startOptions(record.move)));
    const { started, job } = seen.wrote.returned;
    assert.equal(seen.decided.refused, undefined, `${record.path}: the table does not refuse`);
    assert.equal(seen.decided.via, record.via, `${record.path}: the table takes the path the board took`);
    assert.equal(started, record.via === 'start', record.path);
    assert.deepEqual(seen.decided.job, JSON.parse(JSON.stringify(job)), `${record.path}: the table keeps the record the writer kept`);
  }
});

test('clause 1: a start for a gate that moved on is refused by both the START table and the writer [C7,#8279]', t => {
  const [record] = starts.filter(entry => entry.via === 'start');
  const cases = [
    [{ owner: 'someone-else' }, 'SUBMIT_HANDOFF_CHANGED'], [{ digest: 'f'.repeat(64) }, 'SUBMIT_HANDOFF_CHANGED'], [{ status: 'open' }, 'SUBMIT_HANDOFF_CHANGED'],
  ];
  for (const [over, code] of cases) {
    const board = boardFor(t, record.snapshot, over);
    const seen = drive(board, 'startSubmitHandoffShadow', () => assert.throws(() => startSubmitHandoff(board, record.move.id, startOptions(record.move)), { code }));
    assert.equal(seen.decided.refused.code, code, JSON.stringify(over));
    assert.deepEqual(seen.wrote.refused, seen.decided.refused, JSON.stringify(over));
  }
  const board = boardFor(t, record.snapshot);
  const foreign = drive(board, 'startSubmitHandoffShadow', () => assert.throws(() => startSubmitHandoff(board, record.move.id, startOptions({ ...record.move, actor: 'someone-else' })), { code: 'SUBMIT_HANDOFF_CHANGED' }));
  assert.deepEqual(foreign.wrote.refused, foreign.decided.refused);
});

test('clause 1: a merge hook without its receipts is refused by both the START table and the writer [C7,#8279]', t => {
  const [record] = starts.filter(entry => entry.via === 'start');
  const board = boardFor(t, record.snapshot);
  const hook = { job: record.move.job, commit: 'a'.repeat(40), tree: 'b'.repeat(40), digest: record.snapshot.item.frozenDigest, receipts: [] };
  const seen = drive(board, 'startSubmitHandoffShadow', () => assert.throws(() => startSubmitHandoff(board, record.move.id, startOptions({ ...record.move, hook })), { code: 'SUBMIT_HANDOFF_AUTHORITY' }));
  assert.equal(seen.decided.refused.code, 'SUBMIT_HANDOFF_AUTHORITY');
  assert.deepEqual(seen.wrote.refused, seen.decided.refused);
});

test('clause 1: the store submit writer applies the SUBMIT table and agrees on every replayed move [C7,#8280]', t => {
  assert.ok(queues.length >= 5, 'the replay holds the board\'s queued gates');
  for (const record of queues) {
    const board = boardFor(t, record.snapshot);
    const seen = drive(board, 'queueSubmitHandoffShadow', () => queueSubmitHandoff(board, record.move.id, queueOptions(record)));
    const { job, created } = seen.wrote.returned;
    assert.equal(seen.decided.refused, undefined, `${record.path}: the table does not refuse`);
    assert.equal(seen.decided.via, 'queue', record.path);
    assert.equal(created, true);
    assert.deepEqual(seen.decided.job, JSON.parse(JSON.stringify(job)), `${record.path}: the table keeps the record the writer kept`);
  }
});

test('clause 1: a queue by a seat that does not hold the claim is refused by both the SUBMIT table and the writer [C7,#8280]', t => {
  const [record] = queues;
  const lost = [{ owner: 'someone-else' }, { status: 'open' }, { leaseUntil: '2000-01-01T00:00:00.000Z' }];
  for (const over of lost) {
    const board = boardFor(t, record.snapshot, over);
    const seen = drive(board, 'queueSubmitHandoffShadow', () => assert.throws(() => queueSubmitHandoff(board, record.move.id, queueOptions(record)), { code: 'NOT_YOURS' }));
    assert.equal(seen.decided.refused.code, 'NOT_YOURS', JSON.stringify(over));
    assert.deepEqual(seen.wrote.refused, seen.decided.refused, JSON.stringify(over));
  }
});

test('clause 1: a queue behind a pending gate keeps it for the same candidate and refuses another, in both [C7,#8280]', t => {
  const [record] = queues;
  const pending = { ...record.snapshot.handoff, state: 'queued', agentId: record.snapshot.item.owner, digest: record.snapshot.item.frozenDigest, commit: record.snapshot.io.head.commit, tree: record.snapshot.io.head.tree, companionDigest: record.snapshot.io.companionDigest, synthetic: undefined };
  delete pending.synthetic;
  const same = boardFor(t, record.snapshot, { handoff: pending });
  const kept = drive(same, 'queueSubmitHandoffShadow', () => queueSubmitHandoff(same, record.move.id, queueOptions(record)));
  assert.equal(kept.decided.via, 'queue-existing');
  assert.equal(kept.wrote.returned.created, false);
  assert.deepEqual(kept.decided.job, JSON.parse(JSON.stringify(kept.wrote.returned.job)));
  const other = boardFor(t, record.snapshot, { handoff: { ...pending, commit: 'c'.repeat(40) } });
  const refused = drive(other, 'queueSubmitHandoffShadow', () => assert.throws(() => queueSubmitHandoff(other, record.move.id, queueOptions(record)), { code: 'SUBMIT_HANDOFF_PENDING' }));
  assert.equal(refused.decided.refused.code, 'SUBMIT_HANDOFF_PENDING');
  assert.deepEqual(refused.wrote.refused, refused.decided.refused);
});
