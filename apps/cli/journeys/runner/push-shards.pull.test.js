/** The pre-push full gate offers its tracked test files as pull shard jobs with no item; every free runner takes one, and a red shard refuses the push by its failing files [C7,#7743]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { SHARD_JOB_KIND } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';

/** Four node:test files; the one named `red` fails its one case. */
function testFiles(red) {
  return Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [`web/${name}.test.js`, `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('case ${name} holds', () => assert.equal(${JSON.stringify(name === red ? 'red' : 'green')}, 'green'));
`]));
}

/** A pull project whose main gate is `node --test` over four tracked test files, and its board job queue on loopback. */
async function pushProject(t, red = null) {
  const box = await pullProject(t, 1);
  for (const [path, text] of Object.entries(testFiles(red))) { mkdirSync(join(box.repo, 'web'), { recursive: true }); writeFileSync(join(box.repo, path), text); }
  fixtureProjectPolicy(box.repo, { config: { ...JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), gate: 'node --test' } });
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): four gate files [G1]');
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  return { box, ...queue };
}

/** Run pre-push on main while two runners each serve once; resolve the hook's result and the push's shard jobs. */
async function pushWithTwoRunners(box, board, url) {
  const pushing = box.runAsync(box.repo, 'hook', 'pre-push');
  const served = await Promise.all(['r-one', 'r-two'].map(runner => serveOnce(box, url, runner)));
  for (const run of served) assert.equal(run.code, 0, run.output);
  const pushed = await pushing;
  const shards = jobsOf(board.db, { kind: SHARD_JOB_KIND }).filter(job => job.id.startsWith('push:'));
  return { pushed, shards };
}

/** The runner that posted each shard's receipt, and the files each shard ran. */
function shardParts(shards) {
  return shards.map(job => ({ runner: job.steps.find(step => step.name === 'receipt')?.payload.runner ?? null,
    files: job.steps.find(step => step.name === 'receipt')?.payload.receipt.gate.shard.files ?? [] }));
}

test('clause 1: pullboard hook pre-push on main offers its full gate as more than one shard job with no item, and two registered runners each take one [C7,#7743]', { timeout: 240_000 }, // budget: hang ceiling for a project, a hook and two runner processes.
async t => {
  const { box, board, url } = await pushProject(t);
  const { pushed, shards } = await pushWithTwoRunners(box, board, url);
  assert.equal(pushed.code, 0, `${pushed.err}\n${pushed.out}`);
  assert.match(pushed.out, /offered as 2 shard jobs/u);
  assert.equal(shards.length, 2, 'more than one shard job');
  assert.deepEqual(shards.map(job => [job.item, job.step]), [[null, 'done'], [null, 'done']], 'no item; each posted');
  const parts = shardParts(shards);
  assert.deepEqual(parts.map(part => part.runner).sort(), ['r-one', 'r-two'], 'each runner took one shard');
  assert.deepEqual(parts.flatMap(part => part.files).sort(), ['./web/a.test.js', './web/b.test.js', './web/c.test.js', './web/d.test.js'], 'together the shards are every tracked test file, once');
  assert.ok(parts.every(part => part.files.length === 2), 'the weight planner splits four even files two and two');
});

test('clause 1: a red shard refuses the push, and the refusal names the failing file [C7,#7743]', { timeout: 240_000 }, // budget: as clause 1.
async t => {
  const { box, board, url } = await pushProject(t, 'c');
  const { pushed, shards } = await pushWithTwoRunners(box, board, url);
  assert.equal(pushed.code, 1, `${pushed.err}\n${pushed.out}`);
  assert.equal(shards.length, 2);
  const red = shards.find(job => job.steps.find(step => step.name === 'receipt').payload.receipt.gate.green !== true);
  assert.ok(red, 'one shard is red');
  assert.match(pushed.err, /pullboard pre-push: blocked/u);
  assert.match(pushed.err, new RegExp(`the gate is red in 1 of 2 shard jobs \\(${red.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\); failing files: web/c\\.test\\.js\\.`, 'u'));
});
