/** A push shard that posted no receipt names its own files as not run, apart from the failing files [C7,#9370]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shardProblem } from '../../../src/io/hook/push.js';

const names = (prefix, count) => Array.from({ length: count }, (_, at) => `${prefix}${String(at).padStart(2, '0')}.test.js`);

test('cli.io-hook-push-unknown-files.a-shard-with-no-receipt-names-its: clause 1: a shard with no receipt names its files as not run, neither red nor green, and never under failing files [C7,#9370]', () => {
  const plan = { shards: [{ files: ['a.test.js'] }, { files: ['b.test.js'] }, { files: ['c.test.js', 'd.test.js'] }] };
  const jobs = ['j1', 'j2', 'j3'];
  const combined = { gate: { shards: [{ job: 'j1', green: true }, { job: 'j2', green: false }, { job: 'j3', green: false }] } };
  const settled = [{ posted: { receipt: { status: 0 } } }, { posted: { receipt: { status: 1, gate: { phases: [{ role: 'proof', failedFiles: ['b.test.js'] }] } } } }, { posted: null }];
  const problem = shardProblem(combined, settled, plan, jobs, () => []);
  assert.match(problem, /files not run: c\.test\.js, d\.test\.js\./u);
  assert.match(problem, /failing files: b\.test\.js\./u);
  assert.doesNotMatch(problem, /failing files:[^\n]*[cd]\.test\.js/u, 'the unrun files are not called failing');
  assert.doesNotMatch(problem, /red in 2/u, 'an unknown shard is not counted red');
  assert.match(problem, /unknown in 1 of 3 shard jobs \(j3\)/u);
});

test('cli.io-hook-push-unknown-files.more-than-20-unrun-files-name-the: clause 1: more than 20 unrun files name the first 20 and a count after [C7,#9370]', () => {
  const files = names('f', 25);
  const plan = { shards: [{ files }] };
  const combined = { gate: { shards: [{ job: 'j1', green: false }] } };
  const problem = shardProblem(combined, [{ posted: null }], plan, ['j1'], () => []);
  assert.match(problem, /f00\.test\.js/u);
  assert.match(problem, /f19\.test\.js/u);
  assert.doesNotMatch(problem, /f20\.test\.js/u);
  assert.match(problem, /and 5 more/u);
  assert.doesNotMatch(problem, /failing files/u, 'no red shard, so no failing list');
});
