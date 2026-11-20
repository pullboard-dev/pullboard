/** A runner never removes a job folder while that job is still running, even after its worker process is gone [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepRunnerDisk } from '../../../../../runner/index.js';
import { takeResource } from '../../../../../../packages/resources/index.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';

const resources = { takeResource };
const HOUR = 60 * 60 * 1000;
const DEAD_OWNER = { pid: 2 ** 22 - 3, started: 'Mon Jan 1 00:00:00 2001' };

/** A runner root holding one job folder whose worker process died, with a checkout like a real job. */
function jobFolder(t, name, owner = { ...DEAD_OWNER, pgid: 2 ** 22 - 5 }) {
  const root = privateFixtureFiles('pb-job-live-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const job = join(root, 'jobs', name);
  mkdirSync(join(job, 'tmp', 'clone-a', '.git', 'objects'), { recursive: true });
  writeFileSync(join(job, 'tmp', 'clone-a', '.git', 'objects', 'pack'), 'pack');
  if (owner) writeFileSync(join(job, 'worker-owner.json'), JSON.stringify(owner));
  return { root, job };
}

/** Make every path in a job folder look last written the given number of hours ago. */
function ageAll(job, hours) {
  const when = (Date.now() - hours * HOUR) / 1000;
  for (const path of [job, join(job, 'worker-owner.json'), join(job, 'tmp'), join(job, 'tmp', 'clone-a'), join(job, 'tmp', 'clone-a', '.git'), join(job, 'tmp', 'clone-a', '.git', 'objects'), join(job, 'tmp', 'clone-a', '.git', 'objects', 'pack')])
    if (existsSync(path)) utimesSync(path, when, when);
}

/** Run the real runner disk sweep that every worker runs at setup, with a process census naming the given live rows. */
function sweep(root, rows = []) {
  const census = () => new Map(rows.map(row => [row.pid, { state: 'S', started: 'x', ...row }]));
  return sweepRunnerDisk(root, { api: resources, machineHome: join(root, 'machine'), census, diskFree: () => ({ free: 1e12, total: 2e12 }) });
}

test('cli.journeys-runner-job-folder-live.a-long-job-mid-run-keeps: clause 1: a long job mid-run keeps its folder when its worker is gone but a process of its group still runs and writes [C7]', async t => {
  const { root, job } = jobFolder(t, 'running-AAAAAA', { ...DEAD_OWNER, pgid: 4242 });
  const report = await sweep(root, [{ pid: 4243, pgid: 4242 }]);
  assert.ok(existsSync(join(job, 'tmp', 'clone-a', '.git', 'objects', 'pack')), 'the running job keeps its folder');
  assert.deepEqual(report.removedJobs, []);
  assert.ok(report.keptJobs.includes('running-AAAAAA'));
});

test('cli.journeys-runner-job-folder-live.a-live-but-quiet-job-past: clause 1: a live but quiet job past 30 minutes keeps its folder when its worker is gone [C7]', async t => {
  const { root, job } = jobFolder(t, 'quiet-DDDDDD', { ...DEAD_OWNER, pgid: 4242 });
  ageAll(job, 3);
  const report = await sweep(root, [{ pid: 4243, pgid: 4242 }]);
  assert.ok(existsSync(job), 'three quiet hours with a live process of the job keeps the folder, even past 24 hours');
  ageAll(job, 30);
  assert.deepEqual((await sweep(root, [{ pid: 4243, pgid: 4242 }])).removedJobs, [], 'elapsed quiet time never removes a folder while a process of the job is alive');
  assert.deepEqual(report.removedJobs, []);
});

test('cli.journeys-runner-job-folder-live.a-finished-job-with-a-terminal: clause 1: a finished job with a terminal result and no process is removed [C7]', async t => {
  const { root, job } = jobFolder(t, 'done-BBBBBB');
  writeFileSync(join(job, 'job-terminal.json'), '{}\n');
  assert.deepEqual((await sweep(root)).removedJobs, ['done-BBBBBB']);
  assert.ok(!existsSync(job));
});

test('cli.journeys-runner-job-folder-live.a-dead-job-with-no-result: clause 1: a dead job with no result keeps its folder before 24 hours and is removed and logged as abandoned after [C7]', async t => {
  const young = jobFolder(t, 'crashed-CCCCCC');
  ageAll(young.job, 3);
  assert.deepEqual((await sweep(young.root)).removedJobs, [], 'three hours quiet with no result keeps the folder');
  assert.ok(existsSync(young.job));
  const old = jobFolder(t, 'abandoned-FFFFFF');
  ageAll(old.job, 25);
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  let report;
  try { report = await sweep(old.root); } finally { process.stderr.write = realWrite; }
  assert.deepEqual(report.removedJobs, ['abandoned-FFFFFF']);
  assert.deepEqual(report.abandonedJobs, ['abandoned-FFFFFF']);
  assert.ok(written.some(line => line.includes('PULLBOARD_RUNNER_JOB_ABANDONED job=abandoned-FFFFFF')), 'the removal is logged with the job id as abandoned');
  assert.ok(!existsSync(old.job));
});

test('cli.journeys-runner-job-folder-live.a-folder-with-no-owner-record: clause 1: a folder with no owner record keeps its folder under 24 hours without a result and is removed as abandoned after [C7]', async t => {
  const young = jobFolder(t, 'noowner-GGGGGG', null);
  ageAll(young.job, 3);
  assert.deepEqual((await sweep(young.root)).removedJobs, []);
  const old = jobFolder(t, 'noowner-HHHHHH', null);
  ageAll(old.job, 25);
  const report = await sweep(old.root);
  assert.deepEqual(report.removedJobs, ['noowner-HHHHHH']);
  assert.deepEqual(report.abandonedJobs, ['noowner-HHHHHH']);
});
