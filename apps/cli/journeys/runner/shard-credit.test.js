/** Every test file is credited to exactly one shard, and a stranded shard or a watchdog-killed file ends red, counted and never green [C7,#8511]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combinedReceipt } from '../../../../packages/api/index.js';
import { failingParts } from '../../../../packages/api/index.js';
import { planPushShards } from '../../src/io/hook/push.js';
import { shardProblem } from '../../src/io/hook/push.js';
import { censusPlan } from '../../src/logic/census.js';
import { shardRows } from '../../src/logic/census.js';

const FILES = Array.from({ length: 23 }, (_, at) => `test/t${String(at).padStart(2, '0')}.test.js`);
const TIMES = Object.fromEntries(FILES.map((file, at) => [file, ((at * 7) % 11 + 1) * 1000]));
const green = files => ({ runner: 'r', receipt: { status: 0, gate: { green: true, shard: { files }, phases: [{ role: 'proof', status: 0, tail: '' }] } } });

test('clause 1: a shard that posts no receipt ends the push gate red and names its own files as not run [C7,#8511]', () => {
  const plan = { shards: planPushShards(FILES, TIMES, 3).map(shard => ({ files: shard.files })) };
  const jobs = plan.shards.map((_, at) => `job:${at + 1}`);
  // The second shard is stranded: its runner never posted.
  const settled = plan.shards.map((shard, at) => ({ job: jobs[at], posted: at === 1 ? undefined : green(shard.files) }));
  const combined = combinedReceipt({ status: 0, gate: { green: true, phases: [] } }, settled);
  assert.notEqual(combined.status, 0, 'a stranded shard is never green');
  assert.equal(combined.gate.green, false);
  const problem = shardProblem(combined, settled, plan, jobs, failingParts);
  assert.match(problem, /unknown in 1 of 3 shard jobs \(job:2\)/u);
  for (const file of plan.shards[1].files) assert.ok(problem.includes(file), `names ${file}`);
  for (const file of [...plan.shards[0].files, ...plan.shards[2].files]) assert.ok(!problem.includes(file), `${file} ran, so it is not named`);
});

test('clause 2: a file stopped by the per-file watchdog is credited as hung, counted, and never green [C7,#8511]', () => {
  const files = ['a/ok.test.js', 'a/stuck.test.js', 'a/fine.test.js'];
  const output = `run-tests: HUNG file ${JSON.stringify('/work/checkout/a/stuck.test.js')}\n# landing-file-exit 0 a/ok.test.js\n# landing-file-exit 0 a/fine.test.js\n# tests 2\n`;
  const rows = shardRows({ files, status: 'red', host: 'h', label: '1/1', output, outcomes: [], times: {} }, 'sha');
  const status = Object.fromEntries(rows.map(row => [row.file, row.status]));
  assert.deepEqual(status, { 'a/ok.test.js': 'green', 'a/stuck.test.js': 'hung', 'a/fine.test.js': 'green' });
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  assert.equal(counts.hung, 1, 'the killed file is counted');
  // Even a shard that reads green overall never vouches for the killed file.
  const wholeGreen = shardRows({ files, status: 'green', host: 'h', label: '1/1', output, outcomes: [], times: {} }, 'sha');
  assert.equal(wholeGreen.find(row => row.file === 'a/stuck.test.js').status, 'hung');
});

test('clause 3: every test file is credited to exactly one shard, in the push plan at any width and in the census plan [C7,#8511]', () => {
  const sorted = list => [...list].sort();
  for (const width of [1, 2, 3, 5, 8, 40]) {
    const shards = planPushShards([...FILES, FILES[0]], TIMES, width);
    assert.deepEqual(sorted(shards.flatMap(shard => shard.files)), sorted(FILES), `push plan at width ${width}: each file once, a repeated name counted once`);
  }
  const jobs = censusPlan(FILES, 6, TIMES, true, () => []);
  assert.deepEqual(sorted(jobs.flatMap(job => job.files)), sorted(FILES), 'census plan: each file once');
});
