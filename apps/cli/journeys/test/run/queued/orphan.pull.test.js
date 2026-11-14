/** @pullboard-test-loads apps/cli/src/io/test/pull.js */
/** @pullboard-test-loads packages/drive/src/io/queue.js */
/** A seat's pulled test run whose worker stops before the runner posts keeps the runner's result: --status reads the receipt, and the lost sweep records it, never lost [C7,#7574]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MACHINE_CONTEXT_ENV } from '../../../../../../packages/drive/index.js';
import { endLostTestRuns } from '../../../../../../packages/drive/index.js';
import { readTestRun } from '../../../../../../packages/drive/index.js';
import { jobView } from '../../../../../../packages/jobs/index.js';
import { pullProject } from '../../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../../tests/fixtures/pull.js';
import { serveOnce } from '../../../../tests/fixtures/pull.js';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const LIGHT = `export { tapFailures } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/gate/light.js')).href)};\n`;
const PASS = "import { test } from 'node:test';\ntest('passes on the runner', () => {});\n";

/** Run one CLI command as the seat's agent session at its own prompt: the agent-shell marker set, no machine-work variable. */
function asSeat(box, ...args) {
  const saved = Object.fromEntries([...MACHINE_CONTEXT_ENV, 'PULLBOARD_CLI_PID', 'CLAUDECODE'].map(name => [name, box.env[name]]));
  for (const name of Object.keys(saved)) delete box.env[name];
  box.env.CLAUDECODE = '1';
  try { return box.run(box.web, ...args); }
  finally {
    for (const name of Object.keys(saved)) delete box.env[name];
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) box.env[name] = value;
  }
}

test('clause 1: a queued pulled run whose worker stops before the runner posts reports the runner\'s green in --status and is never swept lost [C7,#7574]', { timeout: 180_000 }, // budget: hang ceiling for a project, one test job and one runner process.
async t => {
  const box = await pullProject(t, 1, { tooling: { 'packages/gate/light.js': LIGHT } });
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: focused runner [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/pass.test.js'), PASS);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): a test to run on a runner [G1]');
  const queue = await pullQueue(t, box);

  const queued = asSeat(box, 'test', 'web/pass.test.js');
  assert.equal(queued.code, 0, queued.err);
  const id = /queued test run ([0-9a-f-]{36})/u.exec(queued.out)?.[1];
  assert.ok(id, `the client names its run and exits: ${queued.out}`);

  // The worker offers its runner job; then it stops, as when the starting client's session ends and takes it down.
  await box.helpers.waitFor(() => jobView(queue.board.db, id)?.steps.find(step => step.name === 'pulled')?.payload, 'the worker to offer its runner job', 60_000); // budget: hang ceiling for one worker process to start and offer its job.
  const pid = jobView(queue.board.db, id).steps.find(step => step.name === 'running')?.payload?.pid;
  assert.ok(Number.isSafeInteger(pid), 'the worker recorded its pid');
  try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
  assert.equal(jobView(queue.board.db, id).steps.some(step => step.name === 'result'), false, 'the worker stopped before recording a result');

  const served = await serveOnce(box, queue.url, 'r-test');
  assert.equal(served.code, 0, served.output);

  const status = asSeat(box, 'test', '--status', id);
  assert.equal(status.code, 0, `${status.err}\n${status.out}`);
  assert.match(status.out, new RegExp(`test run ${id} green on r-test`, 'u'), 'the runner\'s receipt is the run\'s result');
  assert.doesNotMatch(status.out + status.err, /lost/u);

  // Long after the worker's lease lapsed, the lost sweep records the receipt as the result instead of marking the run lost.
  assert.deepEqual(endLostTestRuns(queue.board.db, { now: Date.now() + 3_600_000, alive: () => false }), [], 'nothing is marked lost');
  const after = jobView(queue.board.db, id);
  assert.equal(after.steps.some(step => step.name === 'lost'), false);
  assert.equal(after.steps.find(step => step.name === 'result')?.payload?.green, true, 'the sweep recorded the runner\'s green');
  const swept = asSeat(box, 'test', '--status', id);
  assert.match(swept.out, new RegExp(`test run ${id} green on r-test`, 'u'));
  assert.equal(readTestRun(queue.board, id).status, 'green');
});
