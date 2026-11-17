/** @pullboard-test-input packages/store/tests/fixtures/submit-queue-records.json */
/** @pullboard-world-pin reads the recorded queue moves fixture to drive the queue writer with it. The store submit writer applies the SUBMIT table and agrees on every replayed move [C7,#8280]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { queueSubmitHandoff } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

/** The queue moves the board recorded, each with the state it saw; built from the submit history by the moves cell's replay. */
const queues = JSON.parse(readFileSync(new URL('../../../../../store/tests/fixtures/submit-queue-records.json', import.meta.url), 'utf8'));
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

/** The writer's options for a recorded queue move: the captured candidate its snapshot held. */
const queueOptions = (record) => { const { head, companionDigest } = record.snapshot.io; const { item } = record.snapshot;
  return { agentId: record.move.actor, job: record.move.job, ...head, digest: item.frozenDigest, companionDigest, leaseMs: record.snapshot.config.leaseMs }; };

test('board.submit-queue-table.the-store-submit-writer-applies-the: clause 1: the store submit writer applies the SUBMIT table and agrees on every replayed move [C7,#8280]', t => {
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

test('board.submit-queue-table.queue-seat-that-does-not-hold: clause 1: a queue by a seat that does not hold the claim is refused by both the SUBMIT table and the writer [C7,#8280]', t => {
  const [record] = queues;
  const lost = [{ owner: 'someone-else' }, { status: 'open' }, { leaseUntil: '2000-01-01T00:00:00.000Z' }];
  for (const over of lost) {
    const board = boardFor(t, record.snapshot, over);
    const seen = drive(board, 'queueSubmitHandoffShadow', () => assert.throws(() => queueSubmitHandoff(board, record.move.id, queueOptions(record)), { code: 'NOT_YOURS' }));
    assert.equal(seen.decided.refused.code, 'NOT_YOURS', JSON.stringify(over));
    assert.deepEqual(seen.wrote.refused, seen.decided.refused, JSON.stringify(over));
  }
});

test('board.submit-queue-table.queue-behind-pending-gate-keeps-for: clause 1: a queue behind a pending gate keeps it for the same candidate and refuses another, in both [C7,#8280]', t => {
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
