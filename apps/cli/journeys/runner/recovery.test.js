/** @pullboard-test-input apps/cli/src/io/gate/drive.js apps/lib/src/io/handoff/dispatcher.js packages/resources/src/io/handoff/worker/detach.js */
/** @pullboard-world-pin copies the shipped detach entry point into the captured tooling the recovery check relaunches from. */
/** No board command runs dispatcher recovery inline; a background job owns it and still relaunches a dead dispatcher [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../../tests/fixtures/board.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { recoverQueuedHandoffs } from '../../src/io/cli-main/recovery.js';
import { wakesHandoffRecovery } from '../../src/io/cli-main/run.js';
import { startDetachedCheck } from '../../../../packages/drive/index.js';
import { drainHandoffQueue } from '../../../../packages/resources/index.js';
import { handoffDispatcherHeartbeat } from '../../../../packages/resources/index.js';
import { handoffDispatcherMayBeDead } from '../../../../packages/resources/index.js';
import { runRecoveryCheck } from '../../../lib/src/io/handoff/dispatcher.js';
import { queueHandoffLaunch } from '../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../packages/resources/index.js';

const DISPATCHER = fileURLToPath(new URL('../../../lib/src/io/handoff/dispatcher.js', import.meta.url));

/** A private machine home, a repository common dir with a board file, and a captured tools tree; cleaned by the test. */
function fixture(t) {
  const dir = realpathSync(temporaryDirectory('pullboard-recovery-off-path-'));
  const commonDir = join(dir, 'repo.git');
  mkdirSync(join(commonDir, 'pullboard'), { recursive: true });
  writeFileSync(join(commonDir, 'pullboard', 'board.sqlite'), '');
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'bin'), { recursive: true });
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  mkdirSync(join(tools, 'apps/lib/src/io/handoff'), { recursive: true });
  mkdirSync(join(tools, 'packages/resources/src/io/handoff/worker'), { recursive: true });
  const directory = join(dir, 'jobs', 'job1');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: 'job1' }) + '\n');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const io = { cwd: dir, errors: [], err(line) { this.errors.push(line); } };
  return { dir, commonDir, tools, directory, io, git: { repoInfo: () => ({ commonDir }) } };
}

/** Queue the fixture's one captured launch, as a submit does. */
async function queueJob(box) {
  queueHandoffLaunch({ directory: box.directory, tools: box.tools, commonDir: box.commonDir, job: 'job1' }, await reserveHandoffTicket('job1'));
}

/** Age a file so the cheap check treats it as old. */
function age(file, ms) {
  const then = new Date(Date.now() - ms);
  utimesSync(file, then, then);
}

test('clause 1: a command runs no recovery inline: it only hands the job to a detached process, at most once per wake spacing [C7]', async t => {
  const box = fixture(t);
  const starts = [];
  /** A start that never finishes: a command that awaited it would never return. */
  const start = (entry, options) => { starts.push({ entry, options }); return new Promise(() => {}); };
  await queueJob(box);
  // The start returns a promise that never settles, so reaching the next line proves the command did not wait on it.
  await recoverQueuedHandoffs(box.io, box.git, { start });
  assert.equal(starts.length, 1, 'the command handed recovery to one background job');
  assert.equal(starts[0].entry, DISPATCHER);
  assert.deepEqual(starts[0].options, { args: ['--recover'], cwd: box.commonDir });
  await recoverQueuedHandoffs(box.io, box.git, { start });
  assert.equal(starts.length, 1, 'a second command inside the wake spacing starts no second job');
  age(join(process.env.PULLBOARD_MACHINE_HOME, 'handoff-queue', 'recovery-woken'), 60_000);
  await recoverQueuedHandoffs(box.io, box.git, { start });
  assert.equal(starts.length, 2, 'after the spacing a command starts the job again');
  assert.deepEqual(box.io.errors, []);
});

test('clause 1: the background job relaunches only when a launch is queued and no dispatcher heartbeat is fresh [C7]', async t => {
  const box = fixture(t);
  assert.equal(handoffDispatcherMayBeDead(), false, 'an absent queue needs nothing');
  await queueJob(box);
  assert.equal(handoffDispatcherMayBeDead(), true, 'a queued launch with no heartbeat may have a dead dispatcher');
  writeFileSync(handoffDispatcherHeartbeat(), '1\n');
  assert.equal(handoffDispatcherMayBeDead(), false, 'a fresh heartbeat proves a passing dispatcher');
  age(handoffDispatcherHeartbeat(), 60_000);
  assert.equal(handoffDispatcherMayBeDead(), true, 'a stale heartbeat does not');
  const recovered = [];
  await runRecoveryCheck({ recover: async () => { recovered.push('full'); } });
  assert.deepEqual(recovered, ['full'], 'the job runs the full check when the dispatcher may be dead');
  writeFileSync(handoffDispatcherHeartbeat(), '1\n');
  await runRecoveryCheck({ recover: async () => { recovered.push('full'); } });
  assert.deepEqual(recovered, ['full'], 'a live dispatcher costs the job no full check');
});

test('clause 1: reads, heartbeat and Git hooks skip recovery entirely; next, submit and other writes keep it [C7]', () => {
  for (const read of [['whoami'], ['show', '12'], ['status'], ['list', 'core'], ['inbox'], ['lanes'], ['heartbeat'], ['hook', 'commit-msg'], ['hook', 'pre-commit']]) {
    assert.equal(wakesHandoffRecovery(read), false, read.join(' '));
  }
  for (const write of [['next'], ['claim', '12'], ['submit', '12'], ['verify', '12', 'accept'], ['shout', 'all', 'x']]) assert.equal(wakesHandoffRecovery(write), true, write.join(' '));
});

test('clause 1: the detached start returns before the check it started has finished [C7]', async t => {
  const box = fixture(t);
  const marker = join(box.dir, 'check-finished');
  const entry = join(box.dir, 'slow-check.js');
  writeFileSync(entry, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 1500);\n`);
  const pid = startDetachedCheck(entry, { cwd: box.dir });
  assert.ok(Number.isInteger(pid) && pid > 0, 'the check has a process');
  assert.equal(existsSync(marker), false, 'the start returned before the check finished');
  await waitForCondition(() => existsSync(marker), 'the detached check ran to its end');
});

test('clause 2: a drain pass beats the dispatcher heartbeat the cheap check reads [C7]', async t => {
  const box = fixture(t);
  writeFileSync(join(box.tools, 'apps/cli/src/io/gate/drive.js'),
    "require('node:fs').writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[2]), 'result.json'), '{}');\n");
  await queueJob(box);
  assert.deepEqual((await drainHandoffQueue({ capacity: 1 })).started, ['job1']);
  assert.equal(readFileSync(handoffDispatcherHeartbeat(), 'utf8').trim(), String(process.pid), 'the draining process beat the heartbeat');
});

test('clause 2: the detached recovery check relaunches a dead dispatcher from the captured tooling [C7]', async t => {
  const box = fixture(t);
  const marker = join(box.dir, 'dispatcher-started');
  copyFileSync(fileURLToPath(new URL('../../../../packages/resources/src/io/handoff/worker/detach.js', import.meta.url)), join(box.tools, 'packages/resources/src/io/handoff/worker/detach.js'));
  writeFileSync(join(box.tools, 'apps/lib/src/io/handoff/dispatcher.js'), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');\n`);
  await queueJob(box);
  // Process-level: the dispatcher entry runs --recover as its own process.
  const run = spawnSync(process.execPath, [DISPATCHER, '--recover'], { cwd: box.commonDir, env: process.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  await waitForCondition(() => existsSync(marker), 'the captured dispatcher was launched');
  const receipt = JSON.parse(readFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'handoff-queue', 'dispatcher.json'), 'utf8'));
  assert.equal(String(receipt.pid), readFileSync(marker, 'utf8').trim(), 'the launch receipt names the relaunched dispatcher');
});
