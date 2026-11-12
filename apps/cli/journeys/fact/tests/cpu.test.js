/** Declared load is placed by the real runner road, never by a forged host flag [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  join,
  relative,
  sep,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { cpuLoadFixture } from '../../../tests/fixtures/test.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * Run the public landing gate in this process and read its executor line from the gate log.
 * Why: the fixture's runGate starts a node child (about 1 s each); the in-process dispatcher answers the same gate
 * under the fixture's own env, which already drops this file's gate, test-pool and node-test markers, so the gate's
 * own test children and SSH runner stand-in still run as real processes.
 */
async function gate(box) {
  rmSync(join(box.repo, '.git', 'pullboard-gate.log'), { force: true }); // an earlier case's log must not answer for this gate
  const run = await runCliInProcess(['gate', '--landing', '--json'], { cwd: box.repo, env: box.env });
  const log = readFileSync(join(box.repo, '.git', 'pullboard-gate.log'), 'utf8');
  const result = { ...run, context: `${run.stdout}\n${run.stderr}\n${log.slice(-1500)}` };
  const match = /^# CPU_LOAD_EXECUTOR (.+)$/mu.exec(log);
  return { result, log, executor: match ? JSON.parse(match[1]) : null };
}

test('a declared CPU-load test runs only on a runner when one is registered [C7]', async () => {
  const box = cpuLoadFixture(e2e);
  const remote = await gate(box);
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, `the declared CPU-load test dispatches to the registered runner even when local-first has a free slot ${remote.log.slice(-1500)}`);
  assert.ok(remote.executor?.liveLease, 'the test body reports an actual private resource holder');
  assert.equal(remote.executor.runnerExecution, true, 'worker execution is bound to the genuine inherited lease');
  assert.notEqual(remote.executor.cwd, box.repo, 'the declared test body never starts in the coordinator checkout');
  const withinRunner = relative(join(box.remoteHome, '.pullboard-runner', 'jobs'), remote.executor.cwd);
  assert.ok(withinRunner && withinRunner !== '..' && !withinRunner.startsWith(`..${sep}`));
  assert.equal(remote.executor.gatePool, join(box.remoteMachineHome, 'resources.sqlite'));
  box.command('runner', 'remove', 'fixture-host');
  box.commitProbeChange();
  const local = await gate(box);
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 1, 'no unregistered executor is used for the fallback');
  assert.equal(local.executor?.cwd, box.repo);
  assert.match(local.log + local.result.stderr, /CPU.load[\s\S]*no (?:registered )?runners|no runners are registered/iu,
    'the no-runner local fallback explains why it is local');
});


test('a false CPU-load option and textual examples keep ordinary local-first admission [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ cpuLoad: false }' });
  const local = await gate(box);
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0, 'comments, string examples and a false option do not force runner execution');
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});

test('a computed true CPU-load option is not mistaken for a literal false option [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ cpuLoad: false || true }' });
  // Process-level case: this is the first gate on a fresh fixture shell, and in-process it leaves the runner/ssh work
  // unrecorded (requestsMade stays empty); only a child gate's exit ends that work, so it stays a real process.
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('an inline comment in a CPU-load option keeps the test on its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ cpuLoad /* explanation */ : true }' });
  const remote = await gate(box);
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'valid inline comments do not hide the CPU-load declaration');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('a shorthand CPU-load option keeps the test on its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '(() => { const cpuLoad = true; return { cpuLoad }; })()' });
  const remote = await gate(box);
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a valid shorthand CPU-load option does not run on the coordinator');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('a quoted CPU-load key with a Unicode escape uses its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: String.raw`{ "cpu\u004coad": true }` });
  const remote = await gate(box);
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a valid escaped key declares the same CPU-load option');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('a doubly escaped textual key stays ordinary local-first work [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: String.raw`{ "cpu\\u004coad": true }` });
  const local = await gate(box);
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0, 'a literal backslash in a different key is not decoded twice into a CPU declaration');
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});


test('a constant computed template CPU-load key uses its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ [`cpuLoad`]: true }' });
  const remote = await gate(box);
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a constant computed template key declares the same CPU-load option');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('CPU-load syntax inside literal template text stays ordinary local-first work [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ example: `cpuLoad: true` }' });
  const local = await gate(box);
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0, 'template text is an example, not an executable CPU-load option');
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});
