/** @pullboard-world-pin reads the recorded submit history fixture to drive the hand-off completion writer with it. The store hand-off writer applies the COMPLETE table and agrees on every replayed move [C7,#8282]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/src/io/submit/handoff/retry.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board_ensureCoordinator as ensureCoordinator } from '../../../../../store/index.js';
import { completeSubmitHandoff } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { recorded } from '../../../fixtures/submit-history.js';

const STAMP = '2026-01-01T00:00:00.000Z';

/** A real board holding what a recorded completion saw: the item, its submit events and proof receipts, and the saved hand-off job; on a clock at the completion's own instant. */
function boardFor(t, snapshot, handoff = snapshot.handoff) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  ensureCoordinator(board, '/seat/coordinator');
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

/** Run the writer on a board that shadows it: the table's answer and what the writer saved and wrote. */
function drive(board, record) {
  const seen = [];
  board.submitCompleteShadow = (answer) => seen.push(answer);
  const { id, actor, job, result, returnToBoard, windowSpent } = record.move;
  let threw = null;
  try { completeSubmitHandoff(board, id, { agentId: actor, job, result: { ...result, ...(windowSpent ? { windowSpent: true } : {}) }, ...(returnToBoard ? { returnToBoard: true } : {}), reopenFirstRefusalMinutes: 0 }); } catch (error) { threw = error; }
  assert.equal(seen.length, 1, 'the writer ran the table once');
  return { seen: seen[0], threw };
}

const json = (value) => JSON.parse(JSON.stringify(value));
const { records } = recorded();
const completions = records.filter(record => record.table === 'COMPLETE');

test('board.submit-complete-table.the-store-hand-off-completion-writer: clause 1: the store hand-off completion writer applies the COMPLETE table and agrees on every replayed move [C7,#8282]', t => {
  assert.equal(completions.length, 13, 'the replay holds the board\'s thirteen completions');
  for (const record of completions) {
    const { seen, threw } = drive(boardFor(t, record.snapshot), record);
    const where = `${record.path} at event ${record.event.id}`;
    assert.equal(threw, null, where);
    assert.equal(seen.decided.via, record.via, where);
    assert.deepEqual(json(seen.decided.record), json(seen.wrote.record), `the table saves what the writer saved: ${where}`);
    assert.deepEqual(seen.decided.events, seen.wrote.events, `the table writes what the writer wrote: ${where}`);
    assert.deepEqual(seen.wrote.events, record.recorded.events, `the writer writes what the board recorded: ${where}`);
  }
});

test('board.submit-complete-table.completion-worker-that-not-the-current: clause 1: a completion by a worker that is not the current job is refused by both the table and the writer [C7,#8282]', t => {
  const [record] = completions;
  const stranger = { ...record, move: { ...record.move, actor: 'someone-else' } };
  const { seen, threw } = drive(boardFor(t, record.snapshot), stranger);
  assert.equal(seen.decided.refused.code, 'SUBMIT_HANDOFF_CHANGED');
  assert.equal(threw.code, 'SUBMIT_HANDOFF_CHANGED');
});
