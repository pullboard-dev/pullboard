/** Only the runner holding a job's lease token can post its progress, checked as a receipt is (#5758) [P7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { jobView } from '../../../jobs/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { jobQueueCall } from '../../index.js';
import { offerJob } from '../../index.js';

const progressRows = (db, job) => db.prepare("SELECT job_step_seq AS seq, job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'progress'").all(job);
const refusal = call => { try { call(); } catch (error) { return error.code; } return null; };

test('api.progress.progress-post-without-job-lease: clause 2: a progress post without the job\'s lease token is refused, and the holder\'s is recorded [P7]', t => {
  const { root } = privateFixtureFiles('pullboard-jobs-progress-');
  const db = cellBoard(t, join(root, 'board.sqlite')).db;
  const call = body => jobQueueCall(db, body, { mode: 'pull' });
  offerJob(db, { id: 'gate:progress', kind: 'gate', needs: ['node22'] });
  const { claim } = call({ action: 'claim', runner: 'r-holder', capabilities: ['node22'] });
  const progress = { selected: 2, finished: 1, failures: 0, files: { 'tests/a.test.js': 'green', 'tests/b.test.js': 'running' }, latest: ['tests/a.test.js'] };
  for (const [why, body] of [
    ['no token', { action: 'progress', job: 'gate:progress', runner: 'r-holder', progress }],
    ['another runner with the holder\'s token', { action: 'progress', job: 'gate:progress', runner: 'r-other', token: claim.token, progress }],
    ['a token from no claim', { action: 'progress', job: 'gate:progress', runner: 'r-holder', token: 'x'.repeat(32), progress }],
  ]) assert.equal(refusal(() => call(body)), 'JOB_LEASE_MOVED', `${why} is refused`);
  assert.deepEqual(progressRows(db, 'gate:progress'), [], 'no refused post recorded progress');

  const held = { job: 'gate:progress', runner: 'r-holder', token: claim.token };
  assert.equal(refusal(() => call({ action: 'progress', ...held, progress: { ...progress, files: { '/home/user/repo/tests/a.test.js': 'green' } } })), 'JOB_PROGRESS', 'an absolute path is refused');
  assert.equal(refusal(() => call({ action: 'progress', ...held, progress: { ...progress, files: { '../a.test.js': 'green' } } })), 'JOB_PROGRESS', 'a climbing path is refused');
  assert.deepEqual(call({ action: 'progress', ...held, progress }), { job: 'gate:progress', attempt: 1, recorded: true });
  call({ action: 'progress', ...held, progress: { ...progress, finished: 2, files: { ...progress.files, 'tests/b.test.js': 'red' }, failures: 1 } });
  const rows = progressRows(db, 'gate:progress');
  assert.equal(rows.length, 1, 'one row per attempt');
  assert.deepEqual([rows[0].seq, JSON.parse(rows[0].payload).finished], [1, 2], 'the latest post replaces the attempt\'s row');
  const lapsed = Date.now() + LEASE_MS + 1_000;
  const retaken = jobQueueCall(db, { action: 'claim', runner: 'r-next', capabilities: ['node22'] }, { mode: 'pull', now: lapsed }).claim;
  assert.equal(retaken?.job, 'gate:progress', 'progress leaves the job claimable when its lease lapses');
  assert.equal(refusal(() => call({ action: 'progress', ...held, progress })), 'JOB_LEASE_MOVED', 'the old holder\'s token no longer posts');

  const next = { job: 'gate:progress', runner: 'r-next', token: retaken.token };
  jobQueueCall(db, { action: 'receipt', ...next, receipt: { status: 0 } }, { mode: 'pull', now: lapsed });
  assert.equal(jobView(db, 'gate:progress').step, 'done');
  assert.equal(refusal(() => call({ action: 'progress', ...next, progress })), 'JOB_DONE', 'progress ends with the receipt');
});
