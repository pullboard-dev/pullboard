/** @pullboard-test-input packages/gate/index.js */
/** A gate's infrastructure stops rotate to another runner with back-off for up to 30 minutes before the gate gives up [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';

const HOSTS = [HOST, `${HOST}-drop`, `${HOST}-setup`];

/**
 * Build a private pool of three stand-in runners with no real host or relay connection.
 *
 * @param {import('node:test').TestContext} t
 * @returns {object} The project box with its runner list.
 */
function fixture(t) {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'rotate-bin'), worker = join(box.dir, 'rotate-worker');
  const home = join(box.dir, 'rotate-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests: join(box.dir, 'requests.jsonl'), starts: join(box.dir, 'starts.jsonl'), dropFirst: false, nodeCommand: process.execPath });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runners = HOSTS.map(host => ({ host, slots: 1, browser: 0, node: process.execPath }));
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, {
    gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnerWaitMs: 200 }, runners,
  });
  return box;
}

/**
 * The child source: an item check whose action drops its runner's transport for its first `drops` calls, on a fake clock
 * that only the back-off sleeps advance.
 *
 * @param {string} gateUrl
 * @param {number} drops
 * @returns {string}
 */
function scenario(gateUrl, drops) {
  return `import { withGateSlot, RunnerDropped } from ${JSON.stringify(gateUrl)};
${executionServicesSource(gateUrl)}
let clock = 0, calls = 0; const sleeps = [], hosts = [];
const infrastructurePolicy = { startMs: 30000, maxMs: 300000, windowMs: 1800000, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } };
let outcome;
try {
  const result = await withGateSlot(process.cwd(), async lease => {
    calls++; hosts.push(lease.runner?.host ?? 'local');
    if (calls <= ${drops}) throw new RunnerDropped(lease.runner.host, { reason: 'fixture-drop', phase: 'ready' });
    return { isGreen: true, output: 'ROTATED_OK' };
  }, { executionServices, remote: true, runnerWaitMs: 200, itemCheck: true, agent: 'infra-rotate-test', kind: 'submit', item: 'fixture', onWait() {}, infrastructurePolicy });
  outcome = { green: result.isGreen, output: result.output };
} catch (error) { outcome = { code: error.code, message: error.message, attempts: error.infrastructureAttempts ?? [] }; }
console.log(JSON.stringify({ outcome, sleeps, hosts, calls }));`;
}

/**
 * Run a scenario in its private project process and return its structured result.
 *
 * @param {object} box
 * @param {number} drops
 * @returns {{ outcome: object, sleeps: number[], hosts: string[], calls: number }}
 */
function run(box, drops) {
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  // process-level: an inline module scenario, not the CLI.
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', scenario(gate, drops)], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('clause 1: two infrastructure stops retry on two other runners, waiting 30 s then 60 s [C7]', t => {
  const result = run(fixture(t), 2);
  assert.equal(result.outcome.green, true);
  assert.equal(result.outcome.output, 'ROTATED_OK');
  assert.equal(result.calls, 3);
  assert.equal(new Set(result.hosts).size, 3, `each retry took a runner not yet tried (${result.hosts.join(', ')})`);
  assert.deepEqual(result.sleeps, [30_000, 60_000]);
});

test('clause 2: only after the 30 minute window the gate stops as infrastructure naming the runners tried and the last code [C7]', { timeout: 150_000 }, t => {
  const result = run(fixture(t), 1000);
  assert.deepEqual(result.sleeps, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 150_000], 'back-off doubles to 5 minutes and the last wait is cut to the rest of the 30 minute window');
  assert.equal(result.calls, 10, 'ten runs fit the window, the last after the cut wait');
  assert.equal(result.hosts[3], result.hosts[0], 'with every runner tried the least recently tried is next');
  assert.match(result.outcome.message, /30-minute retry window/u);
  for (const host of HOSTS) assert.ok(result.outcome.message.includes(host), `names ${host}`);
  assert.match(result.outcome.message, /last code was \S+ on /u);
  const failures = result.outcome.attempts.filter(attempt => attempt.kind === 'transport-lost');
  assert.equal(failures.length, 10);
  assert.equal(failures.at(-2).waitedSeconds, 150);
  assert.equal(failures.at(-1).waitedSeconds, 0, 'the stop comes only once the whole window has passed');
});

test('clause 2: a spent 30 minute window ends the queued submit at once with one stop, never three more reruns [C7]', async () => {
  const { submitUntilSettled } = await import('../../../lib/index.js');
  let runs = 0;
  const spent = Object.assign(new Error('runner-first check has no available runner (a, b): runners a, b all stopped on infrastructure through the 30-minute retry window'),
    { code: 'RUNNER_UNAVAILABLE', infrastructureWindowSpent: true });
  await assert.rejects(
    submitUntilSettled(async () => { runs += 1; throw spent; }, { healthy: async () => true, wait: async () => {}, say() {} }),
    error => error.code === 'GATE_INFRA_EXHAUSTED' && error.windowSpent === true);
  assert.equal(runs, 1, 'the window was the retry; the submit does not start again');
});
