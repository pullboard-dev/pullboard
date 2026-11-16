/** @pullboard-world-pin reads the recorded submit history and queue moves fixtures to drive the submit writers with them. With moves.live.submit on, the writers follow the COMMIT and SUBMIT tables; off, their own rules decide [C7,#8384]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/tests/fixtures/submit-queue-records.json packages/store/src/io/submission.js packages/store/src/io/submit/handoff/shadow.js packages/store/src/io/submit/handoff/retry.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { recorded } from '../../fixtures/submit-history.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const queues = JSON.parse(readFileSync(new URL('../../fixtures/submit-queue-records.json', import.meta.url), 'utf8'));
const [commitRecord] = recorded().records.filter(record => record.table === 'COMMIT');
const [queueRecord] = queues;

/** A real board holding the one claimed item a recorded move saw, on a clock at the move's own instant; `live` stands in for the moves.live.submit machine setting. */
function boardFor(t, snapshot, { live, owner } = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  if (live !== undefined) board.movesLive = { submit: live };
  board.movesShadow = false;
  board.executionEngineVersion = board.enginePorts.submitHandoffEngines().current;
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', 'claimed', ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, owner ?? item.owner, item.leaseUntil, item.frozenDigest, STAMP, STAMP);
  if (snapshot.handoff) board.enginePorts.shadowJob(sql, item.id, snapshot.handoff, { now: Date.parse(snapshot.now) });
  return board;
}

/** The recorded submit, written through the store's commit writer; `live` is what the submit command reads before its write opens. */
function submitCommit(board, live) {
  const { gate, deferred } = commitRecord.snapshot;
  const { id, actor, commit, tree, note, infra, companionRecord, quarantineProofIds } = commitRecord.move;
  store.recordSubmissionEvent(board, id, { agentId: actor, commit, tree, policyCommit: gate.policyCommit, note, recordedProof: deferred.proofRecord ?? undefined, infra, tooling: gate.tooling,
    modern: true, gateGreen: gate.green, companion: companionRecord, quarantineProofIds, carry: false, recordedSize: gate.size, engineVersion: 9, shadow: false, live });
  return id;
}

/** The submit events a board logged for an item, without the model the log stamps. */
function submitEvents(board, id) {
  return board.db.prepare("SELECT event_kind AS kind, event_by AS by, event_detail AS detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id").all(id)
    .map(({ kind, by, detail }) => ({ kind, by, detail: (({ model, ...rest }) => rest)(JSON.parse(detail)) }));
}

/** The recorded queue, written through the store's queue writer. */
function queueGate(board) {
  const { head, companionDigest } = queueRecord.snapshot.io;
  return store.queueSubmitHandoff(board, queueRecord.move.id, { agentId: queueRecord.move.actor, job: queueRecord.move.job, ...head, digest: queueRecord.snapshot.item.frozenDigest, companionDigest, leaseMs: queueRecord.snapshot.config.leaseMs });
}

test('clause 1: with moves.live.submit on, a submit writes exactly the event the COMMIT table decides [C7,#8384]', t => {
  const board = boardFor(t, commitRecord.snapshot, { live: true });
  const id = submitCommit(board, true);
  const seen = [];
  const shadow = boardFor(t, commitRecord.snapshot);
  shadow.submitCommitShadow = answer => seen.push(answer);
  submitCommit(shadow, false);
  const expected = seen[0].decided;
  assert.ok(expected.length > 0, 'the COMMIT table decided a submit event');
  assert.deepEqual(submitEvents(board, id), expected.map(({ kind, by, detail }) => ({ kind, by, detail })));
});

test('clause 2: with moves.live.submit on, a gate queue follows the SUBMIT table: its refusal with code and next step and nothing written, else its queued job [C7,#8384]', t => {
  const seen = [];
  const shadow = boardFor(t, queueRecord.snapshot);
  shadow.queueSubmitHandoffShadow = answer => seen.push(answer);
  queueGate(shadow);
  const table = seen[0].decided;
  assert.equal(table.via, 'queue');
  const live = boardFor(t, queueRecord.snapshot, { live: true });
  const queued = queueGate(live);
  assert.equal(queued.created, true);
  assert.deepEqual(JSON.parse(JSON.stringify(queued.job)), JSON.parse(JSON.stringify(table.job)), 'the kept record is the table\'s');
  const refused = boardFor(t, queueRecord.snapshot, { live: true, owner: 'someone-else' });
  const before = refused.db.prepare('SELECT COUNT(*) n FROM event').get().n;
  assert.throws(() => queueGate(refused), error => error.code === 'NOT_YOURS' && typeof error.next === 'string' && error.next.length > 0);
  assert.equal(refused.db.prepare('SELECT COUNT(*) n FROM event').get().n, before, 'a refused queue writes no event');
});

test('clause 3: with moves.live.submit off (the default) the writers\' own rules decide [C7,#8384]', t => {
  const board = boardFor(t, commitRecord.snapshot);
  const id = submitCommit(board, false);
  assert.equal(submitEvents(board, id).length, 1, 'the writer logged its own submit event');
  const refused = boardFor(t, queueRecord.snapshot, { owner: 'someone-else' });
  assert.throws(() => queueGate(refused), error => error.code === 'NOT_YOURS' && /claim this item before submitting it/u.test(error.message));
});
