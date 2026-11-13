/** Runner deadlines retain ordinary local admission and never create disabled capacity [C7,Q1,Q2]. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  cli,
  fixtureResultContext,
  gateResult,
  runThroughGate,
} from '../../tests/fixtures/runner/tooling.js';
import {
  HOST,
  shellQuote,
} from '../../tests/fixtures/runner/ssh.js';
import {
  listResources,
  takeResource,
} from '../../../../packages/resources/index.js';
import {
  e2e,
  STAND_IN_BOOT_BUDGET_MS,
  STAND_IN_CEILING_MS,
  fixture,
  observe,
} from '../../tests/fixtures/runner/deadline.js';

test('clause 1: a first lost transport requeues the run onto the same runner without a quarantine or a deadline row [C7,Q1,Q2]', async () => {
  // Since da6ea0ede7 (resource-recovery.js runnerExcluded) one lost transport no longer quarantines a runner: only two
  // failed probes 30 s apart do, so inside the deadline the run is dispatched again rather than waiting on a dead host.
  // The requeue renews this deadline, and the renewed dispatch must reach the stand-in before it passes, even on a loaded runner.
  const box = fixture({ runnerWaitMs: STAND_IN_CEILING_MS });
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  let held;
  let pending;
  try {
    const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'));
    const idle = await takeResource({ name: 'gate', scope: 'machine', root: box.repo, capacity: 1,
      browserCapacityProvider: () => 1, browser: true, gui: true, remote: true,
      runnerProvider: () => settings.runners, runnersFirstProvider: () => false, agent: 'idle-local-control' });
    assert.equal(idle.runner, undefined, 'an idle compatible local slot is not hidden by registered non-GUI runners');
    idle.release();
    held = await takeResource({ name: 'gate', scope: 'machine', root: box.repo, capacity: 1, agent: 'real-local-holder' });
    const command = 'node -e ' + shellQuote("console.log('DEADLINE_LOCAL_EXECUTION')");
    pending = runThroughGate(box.repo, box.env, command, { item: 'deadline-case', requests: box.requests });
    await observe(() => existsSync(box.requests) && readFileSync(box.requests, 'utf8').includes('"dropped":true'), 'the actual SSH transport drop');
    const result = await pending; pending = null;
    assert.equal(result.status, 0, fixtureResultContext(result));
    assert.match(result.stdout, /DEADLINE_LOCAL_EXECUTION/u, 'the command ran through the runner stand-in, which shares this machine\'s filesystem');
    assert.ok(gateResult(result.stdout).runner, 'the requeued run executed on the registered runner, not in the held local slot');
    const calls = readFileSync(box.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call.dropped).length, 1, 'only the first transport is dropped');
    assert.ok(calls.filter(call => !call.healthProbeFailed && !call.dropped).length >= 1, 'a single lost transport does not quarantine the runner: the run is dispatched to it again');
    assert.doesNotMatch(result.stderr, /runner wait deadline/iu, 'the run never reached its runner deadline');
    const resources = cli(box.repo, box.env, 'resources');
    assert.equal(resources.status, 0, fixtureResultContext(resources));
    assert.doesNotMatch(resources.stdout, /runner wait deadline/iu, 'no run is overdue, so public resources names no deadline');
    held.release(); held = null;
    const queue = () => listResources({ scope: 'machine' }).find(resource => resource.name === 'gate');
    assert.equal(queue().holders.length + queue().line.length, 0, 'all private leases drain');
  } finally {
    held?.release();
    if (pending) await pending; // Release the held slot even on a failed assertion, then drain the owned controller.
    for (const [index, key] of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});

test('disabled local capacity and runner-only work refuse by name at the runner deadline [C7,Q1]', () => {
  for (const runnerOnly of [false, true]) {
    const box = fixture();
    const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'));
    writeFileSync(box.settingsFile, JSON.stringify({ ...settings, gateSlots: runnerOnly ? 1 : 0, browserSlots: runnerOnly ? 1 : 0 }));
    const module = pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href;
    const source = `import {withGateSlot} from ${JSON.stringify(module)};
${executionServicesSource(module)}
try { await withGateSlot(${JSON.stringify(box.repo)},()=>{throw Error('disabled execution ran')},{ executionServices,browser:true,gui:true,runnerOnly:${runnerOnly},agent:'deadline-refusal'}); process.exitCode=9; }
catch(error) { console.log(JSON.stringify({code:error.code,message:error.message})); process.exitCode=error.code==='RUNNER_WAIT_DEADLINE'?0:8; }`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
      cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 5_000 }); // budget: a missing 60ms private deadline is a bounded failure, not an immortal test.
    assert.equal(result.status, 0, result.context);
    assert.match(result.stdout, runnerOnly ? /runner.only/iu : /no local capacity/iu);
    assert.match(result.stdout, new RegExp(HOST + '-drop', 'u'));
  }
});

test('clause 1: a registered runner that never answers is canceled at the deadline and the original run executes locally [C7,Q1,Q2]', async () => {
  // A runner that never answers fails its SSH and Node confirming probe too; only that failure quarantines it (#3738).
  const box = fixture({ hold: 'dispatch', runnerWaitMs: STAND_IN_BOOT_BUDGET_MS, transportDown: true });
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  let held;
  let pending;
  try {
    held = await takeResource({ name: 'gate', scope: 'machine', root: box.repo, capacity: 1, agent: 'stalled-local-holder' });
    pending = runThroughGate(box.repo, box.env, 'node -e "console.log(\'STALLED_RUN_LOCAL\')"', { item: 'stalled-case', requests: box.requests });
    await observe(() => existsSync(box.starts), 'the non-answering SSH stand-in actually starting');
    const queue = () => listResources({ scope: 'machine' }).find(resource => resource.name === 'gate');
    await observe(() => queue()?.line.some(row => row.item === 'stalled-case' && row.runnerDeadline), 'deadline cancellation and the original local queue ticket', 3 * STAND_IN_BOOT_BUDGET_MS + 10_000); // budget: the admission deadline, then the renewed deadline after the worker-unresponsive requeue (#1953).
    const waiting = queue().line.find(row => row.item === 'stalled-case');
    assert.match(waiting.runnerDeadline.branch, /local gate slots busy/u);
    assert.match(waiting.runnerDeadline.runners[0].reason, /unreachable/u);
    assert.match(waiting.runnerDeadline.runners[0].reason, /worker did not become ready/u, 'the deadline names worker readiness rather than cleanup');
    assert.equal(readFileSync(box.starts, 'utf8').trim().split('\n').length, 1, 'the non-answering host is not retried');
    held.release(); held = null;
    const result = await pending; pending = null;
    assert.equal(result.status, 0, fixtureResultContext(result));
    assert.match(result.stdout, /STALLED_RUN_LOCAL/u);
    assert.equal(gateResult(result.stdout).runner, undefined);
    assert.match(result.stderr, /runner wait deadline/iu);
    assert.equal(queue().holders.length + queue().line.length, 0);
  } finally {
    held?.release();
    // A deliberately non-answering stand-in is owned by the fixture's existing phase watchdog.
    if (pending) await pending.catch(() => {});
    for (const [index, key] of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});

test('the public runner deadline setting has a five-minute default and rejects unsafe timer values [C7]', () => {
  const box = e2e.project('true');
  const initial = cli(box.repo, box.env, 'settings', '--json');
  assert.equal(initial.status, 0, fixtureResultContext(initial));
  const approvedDefault = 300_000; // budget: the approved five-minute default in milliseconds.
  assert.equal(JSON.parse(initial.stdout).settings.gate.runnerWaitMs, approvedDefault);
  const configuredDuration = 1500; // budget: a private configurable duration whose exact value must persist.
  const changed = cli(box.repo, box.env, 'settings', 'gate.runnerWaitMs', String(configuredDuration), '--json');
  assert.equal(changed.status, 0, fixtureResultContext(changed));
  assert.equal(JSON.parse(changed.stdout).settings.gate.runnerWaitMs, configuredDuration);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const before = readFileSync(file, 'utf8');
  for (const value of ['0', '-1', '1.5', '2147483648', 'Infinity']) {
    const invalid = cli(box.repo, box.env, 'settings', 'gate.runnerWaitMs', value);
    assert.notEqual(invalid.status, 0, fixtureResultContext(invalid));
    assert.equal(readFileSync(file, 'utf8'), before, 'invalid settings never replace the last valid deadline');
  }
});
