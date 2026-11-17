/** @pullboard-test-input packages/store/tests/fixtures/submit-start-records.json */
/** @pullboard-world-pin reads the recorded submit history and start moves fixtures to drive the hand-off writers with them. With moves.live.handoff on, the writers follow the START and COMPLETE tables; off, their own rules decide [C7,#8385]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/tests/fixtures/submit-start-records.json packages/store/src/io/submit/handoff/retry.js packages/store/src/io/submit/handoff/shadow.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { recorded } from '../../fixtures/submit-history.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const starts = JSON.parse(readFileSync(new URL('../../fixtures/submit-start-records.json', import.meta.url), 'utf8'));
const [startRecord] = starts.filter(entry => entry.via === 'start');
const [completion] = recorded().records.filter(record => record.table === 'COMPLETE');

/** A real board holding what a recorded completion saw: the item, its submit events and proof receipts, and the saved hand-off job; on a clock at the completion's own instant. */
function completeBoard(t, snapshot, mode, handoff = snapshot.handoff) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  Object.assign(board, mode);
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
function startBoard(t, snapshot, mode, over = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  Object.assign(board, mode);
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
function completeGate(board, over = {}) {
  const { id, actor, job, result, returnToBoard, windowSpent } = completion.move;
  return store.completeSubmitHandoff(board, id, { agentId: actor, job, result: { ...result, ...(windowSpent ? { windowSpent: true } : {}) }, ...(returnToBoard ? { returnToBoard: true } : {}), reopenFirstRefusalMinutes: 0, ...over });
}

/** The completion's events as the table writes them: kind, writer and detail, without the stamped model. */
function written(board, after) {
  return board.db.prepare('SELECT event_by AS by, event_kind AS kind, event_detail AS detail FROM event WHERE event_id > ? ORDER BY event_id').all(after)
    .map(row => ({ kind: row.kind, by: row.by, detail: (({ model, ...rest }) => rest)(JSON.parse(row.detail)) }));
}

test('clause 1: with moves.live.handoff on, a hand-off start keeps the record the START table decides and refuses what the table refuses [C7,#8385]', t => {
  let decided = null;
  const shadowed = startBoard(t, startRecord.snapshot, { startSubmitHandoffShadow: answer => { decided = answer.decided; } });
  startGate(shadowed);
  assert.equal(decided.via, 'start');
  const live = startBoard(t, startRecord.snapshot, { movesLive: { handoff: true } });
  const result = startGate(live);
  assert.equal(result.started, true);
  assert.deepEqual(result.job, decided.job, 'the record kept is the one the table decided');
  assert.deepEqual(store.submitHandoff(live, startRecord.move.id), decided.job);
  const unserved = startBoard(t, startRecord.snapshot, { movesLive: { handoff: true } }, { status: 'open', owner: null });
  assert.throws(() => startGate(unserved), error => error.code === 'SUBMIT_HANDOFF_CHANGED' && typeof error.next === 'string' && error.next.length > 0);
  assert.equal(store.submitHandoff(unserved, startRecord.move.id).state, 'queued', 'a refused start keeps the queued record');
});

test('clause 2: with moves.live.handoff on, a hand-off completion saves the record and writes the events the COMPLETE table decides [C7,#8385]', t => {
  let decided = null;
  const shadowed = completeBoard(t, completion.snapshot, { submitCompleteShadow: answer => { decided = answer.decided; } });
  completeGate(shadowed);
  assert.ok(decided.events.length, 'the table decided at least the hand-off event');
  const live = completeBoard(t, completion.snapshot, { movesLive: { handoff: true } });
  const after = live.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
  const saved = completeGate(live);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), JSON.parse(JSON.stringify(decided.record)));
  assert.deepEqual(store.submitHandoff(live, completion.move.id), JSON.parse(JSON.stringify(decided.record)));
  const strip = ({ kind, by, detail }) => ({ kind, by, detail });
  assert.deepEqual(written(live, after).filter(event => event.kind !== 'shout'), JSON.parse(JSON.stringify(decided.events.filter(event => event.kind !== 'shout').map(strip))));
  assert.throws(() => completeGate(completeBoard(t, completion.snapshot, { movesLive: { handoff: true } }), { job: 'not-the-queued-job' }),
    error => error.code === 'SUBMIT_HANDOFF_CHANGED' && typeof error.next === 'string' && error.next.length > 0);
});

test('clause 3: with moves.live.handoff off (the default) the writers\' own rules decide and the tables only compare; on, they do not run beside them [C7,#8385]', t => {
  const compares = [];
  for (const live of [false, true]) {
    const started = startBoard(t, startRecord.snapshot, { movesLive: { handoff: live }, startSubmitHandoffShadow: () => compares.push(['start', live]) });
    assert.equal(startGate(started).started, true);
    const completed = completeBoard(t, completion.snapshot, { movesLive: { handoff: live }, submitCompleteShadow: () => compares.push(['complete', live]) });
    completeGate(completed);
  }
  assert.deepEqual(compares, [['start', false], ['complete', false]], 'only the off writers handed their table answer to a shadow compare');
});
