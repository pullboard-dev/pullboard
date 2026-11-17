/** @pullboard-test-input packages/store/tests/fixtures/submit-start-records.json */
/** @pullboard-world-pin reads the recorded submit history and start moves fixtures to drive the hand-off writers with them. With moves.shadow on, the START and COMPLETE compares are recorded on the board; off, nothing is [C7,#8382]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/tests/fixtures/submit-start-records.json packages/store/src/io/submit/handoff/retry.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { recorded } from '../../../fixtures/submit-history.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const starts = JSON.parse(readFileSync(new URL('../../../../../store/tests/fixtures/submit-start-records.json', import.meta.url), 'utf8'));
const [startRecord] = starts.filter(entry => entry.via === 'start');
const [completion] = recorded().records.filter(record => record.table === 'COMPLETE');

/** A real board holding what a recorded completion saw: the item, its submit events and proof receipts, and the saved hand-off job; on a clock at the completion's own instant. */
function completeBoard(t, snapshot, shadow, handoff = snapshot.handoff) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  if (shadow !== undefined) board.movesShadow = shadow;
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  store.board_ensureCoordinator(board, '/seat/coordinator');
  const { item } = snapshot;
  for (const agent of new Set([item.owner, handoff.agentId, ...snapshot.submits.map(event => event.by)].filter(Boolean))) {
    sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(agent, 'core', `/seat/${agent}`, 'strong', STAMP);
  }
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_built_by, item_commit, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', ?, ?, ?, 'frozen', ?, ?, ?, 'coordinator', ?, ?)`)
    .run(item.id, item.status, item.owner, item.leaseUntil, item.frozenDigest, item.builtBy, item.commit, STAMP, STAMP);
  const event = sql.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (const submit of snapshot.submits) event.run(submit.at ?? STAMP, submit.by, 'submit', item.id, JSON.stringify(submit.detail));
  for (const receipt of snapshot.receipts) event.run(STAMP, handoff.agentId, 'proof-run', item.id, JSON.stringify({ receipt }));
  // The jobs cell's port, as a store-side stand-in: the record is a step of the item's gate job, read back the way the board reads it.
  board.enginePorts = { ...board.enginePorts, shadowJob: (db, id, job) => {
    db.prepare("INSERT OR IGNORE INTO job (job_id, job_kind, job_item, job_created, job_updated) VALUES (?, 'gate', ?, 0, 0)").run(job.id, id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = ?').get(job.id, job.state);
    db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, 0)').run(job.id, job.state, n, JSON.stringify({ record: job }));
  } };
  board.enginePorts.shadowJob(sql, item.id, handoff);
  return board;
}

/** A real board holding the one item a recorded move saw and the hand-off record it found, on a clock at the move's own instant. */
function startBoard(t, snapshot, shadow) {
  const over = {};
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  if (shadow !== undefined) board.movesShadow = shadow;
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


/** The recorded start, written through the store's start writer. */
function startGate(board) {
  const { actor, job, id } = startRecord.move;
  return store.startSubmitHandoff(board, id, { agentId: actor, job });
}

/** The recorded completion, written through the store's completion writer. */
function completeGate(board) {
  const { id, actor, job, result, returnToBoard, windowSpent } = completion.move;
  return store.completeSubmitHandoff(board, id, { agentId: actor, job, result: { ...result, ...(windowSpent ? { windowSpent: true } : {}) }, ...(returnToBoard ? { returnToBoard: true } : {}), reopenFirstRefusalMinutes: 0 });
}

test('clause 1: with moves.shadow on, a hand-off start whose START table answer differs adds one disagreement to the recorded counts [C7,#8382]', t => {
  const board = startBoard(t, startRecord.snapshot, true);
  assert.equal(startGate(board).started, true);
  const agreed = store.readShadow(board, 'start');
  assert.equal(agreed.compared, 1, 'the real start was compared once');
  assert.equal(agreed.disagreed, 0, JSON.stringify(agreed.last));
  const hook = store.shadowHook(board, 'startSubmitHandoffShadow', 'start', store.startDiffers, () => true);
  const job = { id: 'j', state: 'running' };
  hook({ id: startRecord.move.id, decided: { via: 'start', job }, wrote: { returned: { started: true, job: { ...job, state: 'queued' } } } });
  const counts = store.readShadow(board, 'start');
  assert.equal(counts.compared, 2);
  assert.equal(counts.disagreed, 1);
  assert.deepEqual(counts.last.map(({ id, differs }) => ({ id, differs })), [{ id: startRecord.move.id, differs: 'job.state' }]);
});

test('clause 2: with moves.shadow on, a hand-off completion whose COMPLETE table answer matches adds one compare and no disagreement [C7,#8382]', t => {
  const board = completeBoard(t, completion.snapshot, true);
  completeGate(board);
  const counts = store.readShadow(board, 'complete');
  assert.equal(counts.compared, 1);
  assert.equal(counts.disagreed, 0, JSON.stringify(counts.last));
});

test('clause 3: with moves.shadow off neither the start writer nor the completion writer records a compare [C7,#8382]', t => {
  const started = startBoard(t, startRecord.snapshot);
  startGate(started);
  assert.equal(store.readShadow(started, 'start'), null);
  const completed = completeBoard(t, completion.snapshot);
  completeGate(completed);
  assert.equal(store.readShadow(completed, 'complete'), null);
});
