/** With jobs.recordLapse on, a claim that takes over a lapsed lease records why the earlier claim lapsed; off, nothing extra is written [C7,#9247]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

/** A board with one land job, claimed by `mill` at t=10_000 for a 120 s lease, which writes a progress step at t=40_000 and never renews. */
function lapsed(t) {
  const { root } = privateFixtureFiles('pullboard-lapse-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'land:1:x', kind: 'land', now: 1000 });
  const first = claimJob(db, { runner: 'mill', now: 10_000, leaseMs: 120_000 });
  db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES ('land:1:x', 'progress', 1, '{}', 40000)").run();
  return { db, first };
}

const stepsOf = db => db.prepare("SELECT job_step_name AS name, job_step_seq AS seq, job_step_payload AS payload FROM job_step WHERE job_step_job = 'land:1:x' ORDER BY rowid").all().map(row => row.name);

test('clause 1: with jobs.recordLapse on, a takeover writes one lapsed step naming the earlier runner, attempt, lease end, last sign of life and last step [test] [C7,#9247]', t => {
  const { db } = lapsed(t);
  const second = claimJob(db, { runner: 'anvil', now: 200_000, leaseMs: 120_000, recordLapse: true });
  assert.equal(second.attempt, 2);
  const rows = db.prepare("SELECT job_step_seq AS seq, job_step_payload AS payload FROM job_step WHERE job_step_job = 'land:1:x' AND job_step_name = 'lapsed'").all();
  assert.equal(rows.length, 1, 'one row per takeover');
  assert.equal(rows[0].seq, 1, 'keyed by the attempt that lapsed');
  assert.deepEqual(JSON.parse(rows[0].payload), { runner: 'mill', attempt: 1, leaseUntil: 130_000, lastAt: 40_000, lastStep: 'progress' });
  assert.equal(db.prepare("SELECT job_step FROM job WHERE job_id = 'land:1:x'").get().job_step, 'claimed', 'the job still reads claimed');
});

test('clause 2: with jobs.recordLapse off (the default) a takeover writes no extra step and the claim result is the same [test] [C7,#9247]', t => {
  const off = lapsed(t);
  const on = lapsed(t);
  const plain = claimJob(off.db, { runner: 'anvil', now: 200_000, leaseMs: 120_000 });
  const recorded = claimJob(on.db, { runner: 'anvil', now: 200_000, leaseMs: 120_000, recordLapse: true });
  assert.ok(!stepsOf(off.db).includes('lapsed'), 'no lapsed step by default');
  const { token: a, ...rest } = plain, { token: b, ...restOn } = recorded;
  assert.deepEqual(rest, restOn, 'the claim result does not change with the setting');
  assert.ok(a && b);
});

test('clause 1: a first claim and a claim of a job whose lease is still live write no lapsed step [test] [C7,#9247]', t => {
  const { db } = lapsed(t);
  assert.equal(claimJob(db, { runner: 'anvil', now: 50_000, leaseMs: 120_000, recordLapse: true }), null, 'a live lease is not taken');
  assert.ok(!stepsOf(db).includes('lapsed'));
});
