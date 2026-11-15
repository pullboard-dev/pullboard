/** A real push of main takes the sharded push gate, runs every shard to its end, and refuses once naming every failing file [C7,#8043]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { SHARD_JOB_KIND } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';

const BIN = join(import.meta.dirname, '../../pullboard.js');

/** Four node:test files; every one named in `red` fails its one case. */
function testFiles(red) {
  return Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [`web/${name}.test.js`, `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('case ${name} holds', () => assert.equal(${JSON.stringify(red.includes(name) ? 'red' : 'green')}, 'green'));
`]));
}

test('clause 1: a push of main with two failing files in two shards runs both shards to the end and names both files [C7,#8043]', { timeout: 240_000 }, // budget: hang ceiling for a project, a hook and two runner processes.
async t => {
  const box = await pullProject(t, 1);
  for (const [path, text] of Object.entries(testFiles(['a', 'd']))) { mkdirSync(join(box.repo, 'web'), { recursive: true }); writeFileSync(join(box.repo, path), text); }
  fixtureProjectPolicy(box.repo, { config: { ...JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), gate: 'node --test' } });
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): four gate files [G1]');
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const head = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  // The exact line git sends for a push of main to a remote that does not have it yet.
  const refs = `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`;
  const pushing = runFixtureChildAsync('sh', ['-c', `printf '%s' "$REFS" | "${process.execPath}" "${BIN}" hook pre-push origin file:///nowhere`], { cwd: box.repo, env: { ...box.env, REFS: refs }, encoding: 'utf8' });
  const served = await Promise.all(['r-one', 'r-two'].map(runner => serveOnce(box, url, runner)));
  for (const run of served) assert.equal(run.code, 0, run.output);
  const pushed = await pushing;
  const shards = jobsOf(board.db, { kind: SHARD_JOB_KIND }).filter(job => job.id.startsWith('push:'));
  assert.equal(shards.length, 2, `a push of main is offered as shard jobs: ${pushed.stderr}\n${pushed.stdout}`);
  assert.ok(shards.every(job => job.step === 'done'), 'neither shard was cut short by the other failing');
  assert.equal(pushed.status, 1, `${pushed.stderr}\n${pushed.stdout}`);
  assert.match(pushed.stderr, /the gate is red in 2 of 2 shard jobs/u);
  assert.match(pushed.stderr, /failing files: web\/a\.test\.js, web\/d\.test\.js\./u);
});
