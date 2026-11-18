/** @pullboard-test-input packages/store/tests/fixtures/submit-queue-records.json */
/** @pullboard-world-pin reads the recorded submit history and queue moves fixtures to drive the submit writers with them. With moves.shadow on, the COMMIT and SUBMIT compares are recorded on the board; off, nothing is [C7,#8379]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/tests/fixtures/submit-queue-records.json packages/store/src/io/submission.js packages/store/src/io/submit/handoff/shadow.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { recorded } from '../../../fixtures/submit-history.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const queues = JSON.parse(readFileSync(new URL('../../../../../store/tests/fixtures/submit-queue-records.json', import.meta.url), 'utf8'));
const [commitRecord] = recorded().records.filter(record => record.table === 'COMMIT');
const [queueRecord] = queues;

/** A real board holding the one claimed item a recorded move saw, on a clock at the move's own instant; `shadow` stands in for moves.shadow. */
function boardFor(t, snapshot, shadow) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  if (shadow !== undefined) board.movesShadow = shadow;
  // The shadow compare runs only while the writer decides; with moves.live.submit on (its default since #8395) the table decides and compares nothing.
  board.movesLive = { submit: false };
  board.executionEngineVersion = board.enginePorts.submitHandoffEngines().current;
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', 'claimed', ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, item.owner, item.leaseUntil, item.frozenDigest, STAMP, STAMP);
  if (snapshot.handoff) board.enginePorts.shadowJob(sql, item.id, snapshot.handoff, { now: Date.parse(snapshot.now) });
  return board;
}

/** The recorded submit, written through the store's commit writer. */
function submitCommit(board) {
  const { gate, deferred } = commitRecord.snapshot;
  const { id, actor, commit, tree, note, infra, companionRecord, quarantineProofIds } = commitRecord.move;
  store.recordSubmissionEvent(board, id, { agentId: actor, commit, tree, policyCommit: gate.policyCommit, note, recordedProof: deferred.proofRecord ?? undefined, infra, tooling: gate.tooling,
    modern: true, gateGreen: gate.green, companion: companionRecord, quarantineProofIds, carry: false, recordedSize: gate.size, engineVersion: 9, shadow: board.movesShadow === true });
  return id;
}

/** The recorded queue, written through the store's queue writer. */
function queueGate(board) {
  const { head, companionDigest } = queueRecord.snapshot.io;
  return store.queueSubmitHandoff(board, queueRecord.move.id, { agentId: queueRecord.move.actor, job: queueRecord.move.job, ...head, digest: queueRecord.snapshot.item.frozenDigest, companionDigest, leaseMs: queueRecord.snapshot.config.leaseMs });
}

test('board.submit-shadow-record.with-moves-shadow-submit-whose-commit: clause 1: with moves.shadow on, a submit whose COMMIT table answer differs adds one disagreement to the commit counts [C7,#8379]', t => {
  const board = boardFor(t, commitRecord.snapshot, true);
  const id = submitCommit(board);
  const agreed = store.readShadow(board, 'commit');
  assert.equal(agreed.compared, 1, 'the real submit was compared once');
  assert.equal(agreed.disagreed, 0, JSON.stringify(agreed.last));
  const hook = store.shadowHook(board, 'submitCommitShadow', 'commit', store.commitDiffers, () => true);
  const event = { kind: 'submit', by: 'core-1', detail: { commit: 'a', tree: 'b' } };
  hook({ id, decided: [{ ...event, detail: { ...event.detail, tree: 'c' } }], wrote: [event] });
  const counts = store.readShadow(board, 'commit');
  assert.equal(counts.compared, 2);
  assert.equal(counts.disagreed, 1);
  assert.deepEqual(counts.last.map(({ id: item, differs }) => ({ item, differs })), [{ item: id, differs: 'events.0.detail.tree' }]);
});

test('board.submit-shadow-record.with-moves-shadow-gate-queue-whose: clause 2: with moves.shadow on, a gate queue whose SUBMIT table answer matches adds one compare and no disagreement [C7,#8379]', t => {
  const board = boardFor(t, queueRecord.snapshot, true);
  assert.equal(queueGate(board).created, true);
  const counts = store.readShadow(board, 'submit');
  assert.equal(counts.compared, 1);
  assert.equal(counts.disagreed, 0, JSON.stringify(counts.last));
});

test('board.submit-shadow-record.with-moves-shadow-off-neither-the: clause 3: with moves.shadow off neither the submit writer nor the queue writer records a compare [C7,#8379]', t => {
  const commitBoard = boardFor(t, commitRecord.snapshot);
  submitCommit(commitBoard);
  assert.equal(store.readShadow(commitBoard, 'commit'), null);
  const queueBoard = boardFor(t, queueRecord.snapshot);
  queueGate(queueBoard);
  assert.equal(store.readShadow(queueBoard, 'submit'), null);
});
