/** A runner claim drives from job through its step index, so the board API never scans job_step [C7,#6716]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { claimableJobs } from '../../index.js';
import { createJob } from '../../index.js';
import { writeStep } from '../../index.js';

const JOBS = 33_000;

/** A board holding 33k finished jobs with their three steps each, plus one open offer. */
function crowdedBoard(t) {
  const { db } = cellBoard(t, ':memory:');
  const job = db.prepare("INSERT INTO job (job_id, job_kind, job_step, job_created, job_updated) VALUES (?, 'test', 'done', ?, ?)");
  const step = db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, 0, '{}', ?)");
  db.exec('BEGIN');
  for (let index = 0; index < JOBS; index++) {
    job.run(`done:${index}`, index, index);
    for (const name of ['offered', 'claimed', 'done']) step.run(`done:${index}`, name, index);
  }
  db.exec('COMMIT');
  createJob(db, { id: 'open:1', kind: 'test', now: JOBS });
  writeStep(db, 'open:1', 'offered', { needs: [], priority: 'interactive' }, { now: JOBS });
  return db;
}

/** The plan SQLite chose for the claim query, captured from the query claimableJobs prepares. */
function claimPlan(db) {
  const plans = [];
  const prepare = db.prepare.bind(db);
  const spy = { prepare: sql => {
    if (/FROM job JOIN job_step/u.test(sql)) plans.push(...prepare(`EXPLAIN QUERY PLAN ${sql}`).all(10, 500).map(row => row.detail));
    return prepare(sql);
  } };
  claimableJobs(spy, { runner: 'r1', now: 10, limit: 500 });
  return plans;
}

test('jobs.claim-plan.index-no-scan: clause 1: the claim query reads job through an index on its step and never scans job_step [C7,#6716]', t => {
  const db = crowdedBoard(t);
  const plan = claimPlan(db);
  assert.ok(plan.length > 0, 'the claim query was planned');
  assert.ok(plan.some(line => /SEARCH job USING (COVERING )?INDEX job_step_lease/u.test(line)), plan.join('\n'));
  assert.ok(!plan.some(line => /^SCAN (job|step|job_step)\b/u.test(line)), `no table scan: ${plan.join('\n')}`);
});

test('jobs.claim-plan.health-under-load: clause 1: the board API answers a health request within 1 s while runners claim from a 33k-row job table [C7,#6716]', { timeout: 60_000 }, // budget: one in-memory board of 33k jobs, no runner.
async t => {
  const db = crowdedBoard(t);
  const server = createServer((request, response) => {
    if (request.url === '/claim') {
      const [first] = claimableJobs(db, { runner: 'r1', now: 10, limit: 500 });
      response.end(JSON.stringify({ job: first?.row.job_id ?? null }));
    } else response.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const claims = Array.from({ length: 20 }, () => fetch(`${base}/claim`).then(response => response.json()));
  const started = performance.now();
  assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
  const waited = performance.now() - started;
  assert.ok(waited < 1_000, `health answered in ${Math.round(waited)} ms`); // budget: declared by the #6716 bar, health within 1 s
  assert.deepEqual(new Set((await Promise.all(claims)).map(row => row.job)), new Set(['open:1']));
});
