/** With census.balanceByTime on, pulled census jobs are cut by measured time and offered heaviest first; off, the plan is today's [C7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balancedJobs } from '../../src/logic/census.js';
import { censusPlan } from '../../src/logic/census.js';
import { rowPackedJobs } from '../../src/logic/census.js';
import { planLandingShards } from '../../../../packages/gate/heavy.js';

// 200 files whose times run 1 to 10 s in a fixed pattern, and two files far heavier than any job.
const FILES = Array.from({ length: 200 }, (_, index) => `dir/f${String(index).padStart(3, '0')}.test.js`);
const TIMES = Object.fromEntries(FILES.map((file, index) => [file, ((index * 7) % 10 + 1) * 1000]));
const HEAVY = ['dir/heavy-a.test.js', 'dir/heavy-b.test.js'];
const ALL = [...FILES, ...HEAVY];
const WITH_HEAVY = { ...TIMES, [HEAVY[0]]: 400_000, [HEAVY[1]]: 300_000 };
const median = list => { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

test('cli.logic-census-balance.with-census-balancebytime-on-and-known-file: clause 1: with census.balanceByTime on and known file times, each job weighs within 1.25x of the median job, or holds one file [C7]', () => {
  const jobs = censusPlan(ALL, 12, WITH_HEAVY, true, () => assert.fail('the landing planner is not used'));
  const middle = median(jobs.map(job => job.weight));
  for (const job of jobs) assert.ok(job.files.length === 1 || job.weight <= 1.25 * middle, `job of ${job.files.length} files weighs ${job.weight} against median ${middle}`);
  assert.deepEqual([...jobs.flatMap(job => job.files)].sort(), [...ALL].sort(), 'every file runs once');
  assert.ok(jobs.filter(job => job.files.length === 1).length >= 2, 'each heavy file holds a job alone');
});

test('cli.logic-census-balance.with-census-balancebytime-on-jobs-are-offered: clause 2: with census.balanceByTime on, jobs are offered heaviest first [C7]', () => {
  const jobs = censusPlan(ALL, 12, WITH_HEAVY, true, () => []);
  const weights = jobs.map(job => job.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
  assert.deepEqual(jobs[0].files, [HEAVY[0]]);
  assert.equal(balancedJobs(ALL, 12, WITH_HEAVY).length, jobs.length);
});

test('cli.logic-census-balance.with-census-balancebytime-off-the-default-the: clause 3: with census.balanceByTime off, the default, the plan is the same as today [C7]', () => {
  const today = planLandingShards(ALL, 12, WITH_HEAVY, null);
  const planned = censusPlan(ALL, 12, WITH_HEAVY, false, () => planLandingShards(ALL, 12, WITH_HEAVY, null));
  assert.deepEqual(planned, today);
  assert.deepEqual(censusPlan(ALL, 12, {}, false, () => planLandingShards(ALL, 12, {}, null)), planLandingShards(ALL, 12, {}, null));
});

test('cli.logic-census-balance.row-times-pack-to-total-over-shards: clause 1: rowPackedJobs cuts 2,000 files with skewed row times into 80 jobs, the largest at most 1.1 times the larger of total/80 and the heaviest file, and a file-count split with no times [C7]', () => {
  const files = Array.from({ length: 2000 }, (_, index) => `dir/r${String(index).padStart(4, '0')}.test.js`);
  const secs = index => (index === 0 ? 100 : index <= 30 ? 20 : 0.1 + ((index * 13) % 30) / 10);
  const rows = files.map((file, index) => ({ file, status: 'green', secs: secs(index) }));
  const total = rows.reduce((sum, row) => sum + Math.round(row.secs * 1000), 0);
  const jobs = rowPackedJobs(files, 80, rows, {});
  assert.ok(jobs.length <= 80);
  assert.deepEqual(jobs.flatMap(job => job.files).sort(), [...files].sort(), 'every file runs once');
  assert.ok(jobs[0].weight <= 1.1 * Math.max(total / 80, 100_000), `largest job ${jobs[0].weight} ms against total ${total}`);
  const bare = rowPackedJobs(files, 80, [], {}).map(job => job.files.length);
  assert.ok(Math.max(...bare) - Math.min(...bare) <= 1, 'with no times jobs differ by at most one file');
  const pair = rowPackedJobs([files[0], files[1]], 2, [{ file: files[0], status: 'green', secs: 9 }], { [files[0]]: 1000, [files[1]]: 5000 });
  assert.deepEqual(pair[0].files, [files[0]], 'a row time beats the recorded time');
});
