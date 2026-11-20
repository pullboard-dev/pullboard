/** A push gate shard that posted no receipt reads unknown, never red or green, and the message says so apart from the red ones [C7,#8046]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shardProblem } from '../../../src/io/hook/push.js';

const plan = { shards: [{ files: ['a.test.js'] }, { files: ['b.test.js'] }, { files: ['c.test.js'] }] };
const jobs = ['j1', 'j2', 'j3'];
const combined = { gate: { shards: [{ job: 'j1', green: true }, { job: 'j2', green: false }, { job: 'j3', green: false }] } };
const settled = [{ posted: { receipt: { status: 0 } } }, { posted: { receipt: { status: 1, gate: { phases: [{ role: 'proof', failedFiles: ['b.test.js'] }] } } } }, { posted: null }];

test('cli.io-hook-push-unknown.a-shard-with-no-posted-receipt-is: clause 1: a shard with no posted receipt is unknown, apart from a red shard, and the tree is not stamped green [C7,#8046]', () => {
  const problem = shardProblem(combined, settled, plan, jobs, () => []);
  assert.match(problem, /red in 1 of 3 shard jobs \(j2\); failing files: b\.test\.js/u);
  assert.match(problem, /unknown in 1 of 3 shard jobs \(j3\)/u);
  assert.doesNotMatch(problem, /red in 2/u, 'the unknown shard is not counted red');
  assert.doesNotMatch(/failing files: ([^\n]*?)\. fix them/u.exec(problem)?.[1] ?? '', /c\.test\.js/u, 'its files are not called failing');
});

test('cli.io-hook-push-unknown.with-only-an-unknown-shard-the-message: clause 1: with only an unknown shard the message names no red shard [C7,#8046]', () => {
  const only = { gate: { shards: [{ job: 'j1', green: true }, { job: 'j2', green: true }, { job: 'j3', green: false }] } };
  const problem = shardProblem(only, [settled[0], settled[0], settled[2]], plan, jobs, () => []);
  assert.doesNotMatch(problem, /is red/u);
  assert.match(problem, /unknown in 1 of 3/u);
});
