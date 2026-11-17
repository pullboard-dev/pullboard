/** @pullboard-test-input packages/store/tests/fixtures/submit-start-records.json */
/** @pullboard-world-pin reads the recorded start moves fixture to drive the hand-off start writer with it. The store hand-off start writer applies the START table and agrees on every replayed move [C7,#8279]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { startSubmitHandoff } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

/** The start and requeue moves the board recorded, each with the state it saw; built from the submit history by the moves cell's replay. */
const starts = JSON.parse(readFileSync(new URL('../../../../../store/tests/fixtures/submit-start-records.json', import.meta.url), 'utf8'));
const STAMP = '2026-01-01T00:00:00.000Z';

/** A real board holding the one item a recorded move saw and the hand-off record it found, on a clock at the move's own instant. */
function boardFor(t, snapshot, over = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  board.executionEngineVersion = board.enginePorts.submitHandoffEngines().current;
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
