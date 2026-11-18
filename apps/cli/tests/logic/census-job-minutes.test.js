/** With census.jobMinutes set, pulled census jobs are cut to that many minutes of measured time; unset, jobs keep 40 files [C7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PULLED_FILES_PER_JOB } from '../../src/logic/census.js';
import { censusPlan } from '../../src/logic/census.js';
import { pulledShardCount } from '../../src/logic/census.js';
import { timeBoundJobs } from '../../src/logic/census.js';

const MIN = 60_000;
const FILES = Array.from({ length: 300 }, (_, index) => `dir/f${String(index).padStart(3, '0')}.test.js`);
const TIMES = Object.fromEntries(FILES.map((file, index) => [file, ((index * 7) % 10 + 1) * 4000]));
const SLOW = 'dir/slow.test.js';
const ALL = [...FILES, SLOW];
const WITH_SLOW = { ...TIMES, [SLOW]: 5 * MIN };
const total = list => list.reduce((sum, ms) => sum + ms, 0);

test('cli.logic-census-job-minutes.with-census-jobminutes-set-to-3-and: clause 1: with census.jobMinutes set to 3 and known file times, no planned job weighs over the larger of 3 min and its slowest file, and the job count is at least ceil(total / 3 min) [C7]', () => {
  const jobs = censusPlan(ALL, 4, WITH_SLOW, false, () => assert.fail('the landing planner is not used'), 3);
  for (const job of jobs) assert.ok(job.weight <= Math.max(3 * MIN, ...job.files.map(file => WITH_SLOW[file])), `job of ${job.files.length} files weighs ${job.weight}`);
  const timed = timeBoundJobs(FILES, TIMES, 3 * MIN);
  assert.ok(timed.length >= Math.ceil(total(Object.values(TIMES)) / (3 * MIN)), `${timed.length} jobs for files none over 3 min`);
  assert.ok(jobs.length >= timed.length + 1, 'the slow file adds its own job');
  assert.deepEqual([...jobs.flatMap(job => job.files)].sort(), [...ALL].sort(), 'every file runs once');
  assert.deepEqual(jobs[0].files, [SLOW], 'the slow file holds a job alone, offered first');
  assert.deepEqual(jobs.map(job => job.weight), jobs.map(job => job.weight).sort((a, b) => b - a), 'heaviest first');
  assert.deepEqual(timeBoundJobs(ALL, WITH_SLOW, 3 * MIN), jobs, 'the same plan every time, whatever count the caller holds');
});

test('cli.logic-census-job-minutes.with-census-jobminutes-unset-the-default-pulledshardcount: clause 2: with census.jobMinutes unset, the default, pulledShardCount is unchanged and jobs keep 40 files [C7]', () => {
  assert.equal(PULLED_FILES_PER_JOB, 40);
  assert.equal(pulledShardCount(1694, 10), Math.ceil(1694 / 40));
  assert.equal(pulledShardCount(100, 10), 10);
  const base = [{ files: ['a'], weight: 1 }];
  assert.equal(censusPlan(ALL, 4, WITH_SLOW, false, () => base, null), base, 'unset falls through to the plan as today');
  assert.equal(censusPlan(ALL, 4, WITH_SLOW, false, () => base), base);
  assert.ok(timeBoundJobs(FILES, {}, 3 * MIN).every(job => job.files.length <= 40), 'even a time-bound job never holds more than 40 files');
});
