/** Durable gate 1/20: the job and job_step tables, idempotent step writes and the job view [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openBoard } from '../../index.js';
import { closeBoard } from '../../index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { renewLease } from '../../../../packages/jobs/index.js';
import { reclaimLapsed } from '../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../packages/jobs/index.js';
import { gatePanel } from '../../../../packages/jobs/index.js';
import { stalledGates } from '../../../../packages/jobs/index.js';

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(':memory:');
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: the board opens with job and job_step tables whose step key is unique on (job, name, seq) [C7]', () => {
  withBoard('tables', (db) => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('job','job_step') ORDER BY name").all().map(row => row.name);
    assert.deepEqual(names, ['job', 'job_step']);
    createJob(db, { id: 'j1', kind: 'gate', now: 1 });
    db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_at) VALUES ('j1', 's', 0, 1)").run();
    assert.throws(() => db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_at) VALUES ('j1', 's', 0, 2)").run(), /UNIQUE/u);
  });
});

test('clause 2: writeStep is a no-op on a repeat and returns the stored payload [C7]', () => {
  withBoard('repeat', (db) => {
    createJob(db, { id: 'j2', kind: 'gate', item: 7, now: 1 });
    assert.deepEqual(writeStep(db, 'j2', 'captured', { tree: 'aaa' }, { now: 2 }), { written: true, payload: { tree: 'aaa' } });
    assert.deepEqual(writeStep(db, 'j2', 'captured', { tree: 'bbb' }, { now: 3 }), { written: false, payload: { tree: 'aaa' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_step').get().n, 1);
    assert.deepEqual(writeStep(db, 'j2', 'shard.done', { shard: 1 }, { seq: 1, now: 4 }).written, true);
    assert.deepEqual(writeStep(db, 'j2', 'shard.done', { shard: 2 }, { seq: 2, now: 5 }).written, true);
    assert.throws(() => writeStep(db, 'nope', 'captured'), { code: 'JOB_MISSING' });
  });
});

test('clause 3: jobView returns the current step, the last one written [C7]', () => {
  withBoard('view', (db) => {
    assert.equal(jobView(db, 'absent'), null);
    createJob(db, { id: 'j3', kind: 'gate', item: 9, candidate: 'c1', base: 'b1', now: 1 });
    assert.equal(jobView(db, 'j3').step, 'queued');
    writeStep(db, 'j3', 'captured', { tree: 't' }, { now: 2 });
    writeStep(db, 'j3', 'running', { runner: 'r1' }, { now: 3 });
    writeStep(db, 'j3', 'captured', {}, { now: 4 });
    const view = jobView(db, 'j3');
    assert.equal(view.step, 'running');
    assert.deepEqual(view.steps.map(step => step.name), ['captured', 'running']);
    assert.equal(view.item, 9);
    assert.equal(view.updated, 3);
    assert.equal(createJob(db, { id: 'j3', kind: 'gate' }).step, 'running');
  });
});

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoardPart2(name, body) {
  const board = openBoard(':memory:');
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: takeJob succeeds only when the lease has lapsed [C7]', () => {
  withBoardPart2('take', (db) => {
    createJob(db, { id: 'j1', kind: 'gate', now: 1000 });
    assert.equal(takeJob(db, 'j1', 'driver-a', { now: 1000 }).taken, true);
    const second = takeJob(db, 'j1', 'driver-b', { now: 1000 + LEASE_MS - 1 });
    assert.equal(second.taken, false);
    assert.equal(second.job.leaseOwner, 'driver-a');
    const third = takeJob(db, 'j1', 'driver-b', { now: 1000 + LEASE_MS + 1 });
    assert.equal(third.taken, true);
    assert.equal(third.job.leaseOwner, 'driver-b');
    assert.throws(() => takeJob(db, 'absent', 'driver-a'), { code: 'JOB_MISSING' });
  });
});

test('clause 2: renewLease moves lease_until only for the holder with a live lease [C7]', () => {
  withBoardPart2('renew', (db) => {
    createJob(db, { id: 'j2', kind: 'gate', now: 0 });
    takeJob(db, 'j2', 'driver-a', { now: 10_000 });
    assert.equal(renewLease(db, 'j2', 'driver-a', { now: 15_000 }), true);
    assert.equal(db.prepare('SELECT job_lease_until FROM job WHERE job_id = ?').get('j2').job_lease_until, 15_000 + LEASE_MS);
    assert.equal(renewLease(db, 'j2', 'driver-b', { now: 16_000 }), false);
    assert.equal(renewLease(db, 'j2', 'driver-a', { now: 15_000 + LEASE_MS + 1 }), false);
  });
});

test('clause 3: reclaimLapsed returns taken jobs whose lease lapsed, 2 minutes after the last renewal [C7]', () => {
  withBoardPart2('reclaim', (db) => {
    for (const id of ['queued', 'live', 'silent']) createJob(db, { id, kind: 'gate', now: 0 });
    takeJob(db, 'live', 'a', { now: 50_000 });
    takeJob(db, 'silent', 'a', { now: 1 });
    renewLease(db, 'silent', 'a', { now: 10_000 });
    assert.deepEqual(reclaimLapsed(db, { now: 10_000 + LEASE_MS }), [], 'at the lease end it is still held');
    const lapsed = reclaimLapsed(db, { now: 10_000 + LEASE_MS + 1 });
    assert.deepEqual(lapsed.map(job => job.id), ['silent'], 'one ms after 2 minutes of silence it is reclaimable; queued and live are not');
    assert.equal(lapsed[0].lapsedMs, 1);
    assert.equal(reclaimLapsed(db, { now: 50_000 + LEASE_MS + 1 }).length, 2);
  });
});

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoardPart3(name, body) {
  const board = openBoard(':memory:');
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: show and status read the gate panel from the jobs cell jobView [C7]', () => {
  withBoardPart3('live', (db) => {
    createJob(db, { id: 'g1', kind: 'gate', item: 5, now: 0 });
    assert.equal(gatePanel(db, 'g1', { now: 1000 }).text, 'queued');
    takeJob(db, 'g1', 'driver', { now: 1000 });
    writeStep(db, 'g1', 'running', {}, { now: 1000 });
    assert.equal(gatePanel(db, 'g1', { now: 1000 + LEASE_MS }).text, 'running');
    assert.equal(gatePanel(db, 'absent'), null);
  });
});

test('clause 1: a job whose lease lapsed shows stalled (reclaimable) with its age [C7]', () => {
  withBoardPart3('stalled', (db) => {
    createJob(db, { id: 'g2', kind: 'gate', item: 6, now: 0 });
    takeJob(db, 'g2', 'driver', { now: 60_000 });
    writeStep(db, 'g2', 'running', {}, { now: 60_000 });
    const panel = gatePanel(db, 'g2', { now: 60_000 + LEASE_MS + 5 * 60_000 });
    assert.equal(panel.text, 'stalled (reclaimable) 5m');
    assert.equal(panel.stalled, true);
  });
});

test('clause 1: the nine ghost-gate shapes from 6 Nov render as stalled (reclaimable) in a fixture [C7]', () => {
  withBoardPart3('ghosts', (db) => {
    const now = 10 * 60 * 60_000;
    /** [id, steps, taken-at or null] for nine jobs that read running or queued with nobody driving. */
    const shapes = [
      ['ghost1', ['running'], null],
      ['ghost2', ['running'], 1000],
      ['ghost3', ['queued'], 2000],
      ['ghost4', ['running', 'running'], 3000],
      ['ghost5', ['queued', 'running'], 4000],
      ['ghost6', ['running'], 5000],
      ['ghost7', ['queued'], 6000],
      ['ghost8', ['running'], null],
      ['ghost9', ['queued', 'running'], 7000],
    ];
    shapes.forEach(([id, steps, takenAt], index) => {
      createJob(db, { id, kind: 'gate', item: 100 + index, now: 500 });
      if (takenAt !== null) takeJob(db, id, 'dead-driver', { now: takenAt });
      steps.forEach((step, seq) => { if (step !== 'queued') writeStep(db, id, step, {}, { seq, now: 500 + seq }); });
    });
    createJob(db, { id: 'waiting', kind: 'gate', item: 200, now: now - 1000 });
    createJob(db, { id: 'done', kind: 'gate', item: 201, now: 0 });
    writeStep(db, 'done', 'green', {}, { now: 1 });
    for (const [id] of shapes) {
      const panel = gatePanel(db, id, { now });
      assert.equal(panel.stalled, true, `${id} is stalled`);
      assert.match(panel.text, /^stalled \(reclaimable\) \d+m$/u);
    }
    assert.equal(gatePanel(db, 'waiting', { now }).text, 'queued');
    assert.equal(gatePanel(db, 'done', { now }).text, 'green');
    assert.deepEqual(stalledGates(db, { now }).map(row => row.id).sort(), shapes.map(([id]) => id).sort());
  });
});
