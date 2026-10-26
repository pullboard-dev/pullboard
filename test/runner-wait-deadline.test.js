/** Runner deadlines retain ordinary local admission and never create disabled capacity [C7,Q1,Q2]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from './e2e-helpers.js';
import { cleanupFixtureChildren, runFixtureChild } from './fixture-child.js';
import { cleanupToolingSnapshots, cli, fixtureResultContext, gateResult, runThroughGate } from './runner-tooling-fixture.js';
import { HOST, installSshStandIn, shellQuote } from './runner-ssh-fixture.js';
import { listResources, takeResource } from '../src/resources.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

/** Build the real loopback SSH transport in an isolated machine, with a short private deadline. */
function fixture({ hold = '', runnerWaitMs = 60, dropFirst = !hold } = {}) {
  const box = e2e.project('true');
  const paths = Object.fromEntries(['bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(box.dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl');
  const starts = join(box.dir, 'starts.jsonl');
  const stderrLog = join(box.dir, 'worker-stderr.log');
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome,
    machineHome: paths.remoteMachine, requests, starts, hold, dropFirst, stderrLog });
  box.env.PATH = paths.bin + ':' + box.env.PATH;
  const added = cli(box.repo, box.env, 'runner', 'add', HOST + '-drop', '--slots', '1', '--browser', '1');
  assert.equal(added.status, 0, fixtureResultContext(added));
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  writeFileSync(settingsFile, JSON.stringify({ ...settings, gateSlots: 1, browserSlots: 1,
    gate: { ...settings.gate, runnerWaitMs, runnersFirst: false } }));
  return { ...box, requests, starts, stderrLog, settingsFile };
}

/** Observe a real fixture phase, with cleanup owned by the caller rather than a production timeout override. */
async function observe(predicate, description) {
  const until = Date.now() + 10_000; // budget: private Git and SSH startup; no production deadline extension.
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('fixture did not reach ' + description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('a gate run waiting for an unreachable runner falls back to a local slot after the deadline and names the runner [C7,Q1,Q2]', async () => {
  const box = fixture({ runnerWaitMs: 1_000 });
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
    const marker = join(box.dir, 'ran-locally');
    const command = 'node -e ' + shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'actual local command'); console.log('DEADLINE_LOCAL_EXECUTION')`);
    pending = runThroughGate(box.repo, box.env, command, { item: 'deadline-case', requests: box.requests });
    await observe(() => existsSync(box.requests) && readFileSync(box.requests, 'utf8').includes('"dropped":true'), 'the actual SSH transport drop');
    const queue = () => listResources({ scope: 'machine' }).find(resource => resource.name === 'gate');
    await observe(() => queue()?.line.some(row => row.item === 'deadline-case'), 'the original run requeued after transport loss');
    const first = queue().line.find(row => row.item === 'deadline-case');
    await new Promise(resolve => setTimeout(resolve, 1_100)); // budget: pass the private one-second deadline while the real local holder stays held.
    const resources = cli(box.repo, box.env, 'resources');
    assert.equal(resources.status, 0, fixtureResultContext(resources));
    assert.match(resources.stdout, /runner wait deadline/iu, 'public resources names the overdue run');
    assert.match(resources.stdout, new RegExp(HOST + '-drop.*unreachable', 'iu'), 'the actual dropped runner and reason are named');
    const status = cli(box.repo, box.env, 'status');
    assert.equal(status.status, 0, fixtureResultContext(status));
    assert.match(status.stdout, /runner wait deadline/iu, 'ordinary status also names a run past its runner deadline');
    const current = queue().line.find(row => row.item === 'deadline-case');
    assert.equal(current.since, first.since, 'fallback preserves the original queue age');
    assert.equal(existsSync(marker), false, 'the deadline never bypasses a live local holder');
    held.release(); held = null;
    const result = await pending; pending = null;
    assert.equal(result.status, 0, fixtureResultContext(result));
    assert.match(result.stdout, /DEADLINE_LOCAL_EXECUTION/u);
    assert.equal(gateResult(result.stdout).runner, undefined, 'the command actually executes locally');
    assert.match(result.stderr, new RegExp(HOST + '-drop.*unreachable', 'iu'), 'fallback emits the named runner reason');
    assert.equal(readFileSync(box.requests, 'utf8').trim().split('\n').length, 1, 'a quarantined runner is not retried after the deadline');
    assert.equal(queue().holders.length + queue().line.length, 0, 'all private leases drain');
  } finally {
    held?.release();
    if (pending) await pending; // Release the held slot even on a missing-deadline assertion, then drain the owned controller.
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
    const module = pathToFileURL(join(import.meta.dirname, '../src/gate.js')).href;
    const source = `import {withGateSlot} from ${JSON.stringify(module)};
try { await withGateSlot(${JSON.stringify(box.repo)},()=>{throw Error('disabled execution ran')},{browser:true,gui:true,runnerOnly:${runnerOnly},agent:'deadline-refusal'}); process.exitCode=9; }
catch(error) { console.log(JSON.stringify({code:error.code,message:error.message})); process.exitCode=error.code==='RUNNER_WAIT_DEADLINE'?0:8; }`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
      cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 5_000 }); // budget: a missing 60ms private deadline is a bounded failure, not an immortal test.
    assert.equal(result.status, 0, result.context);
    assert.match(result.stdout, runnerOnly ? /runner.only/iu : /no local capacity/iu);
    assert.match(result.stdout, new RegExp(HOST + '-drop', 'u'));
  }
});

test('a registered runner that never answers is canceled at the deadline and the original run executes locally [C7,Q1,Q2]', async () => {
  const box = fixture({ hold: 'dispatch', runnerWaitMs: 1_000 });
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
    await observe(() => queue()?.line.some(row => row.item === 'stalled-case' && row.runnerDeadline), 'deadline cancellation and the original local queue ticket');
    const waiting = queue().line.find(row => row.item === 'stalled-case');
    assert.match(waiting.runnerDeadline.branch, /local gate slots busy/u);
    assert.match(waiting.runnerDeadline.runners[0].reason, /unreachable/u);
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

test('an executing runner command keeps its test budget after the admission deadline [C7]', async () => {
  const box = fixture({ runnerWaitMs: 5_000, dropFirst: false });
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  let held;
  let pending;
  try {
    held = await takeResource({ name: 'gate', scope: 'machine', root: box.repo, capacity: 1, agent: 'admitted-run-local-holder' });
    const started = Date.now();
    pending = runThroughGate(box.repo, box.env,
      'node -e "setTimeout(()=>console.log(\'ADMITTED_LONG_COMMAND\'),6000)"', { requests: box.requests });
    await observe(() => existsSync(box.stderrLog) && readFileSync(box.stderrLog, 'utf8').includes('PULLBOARD_RUNNER_READY '), 'the real worker READY frame');
    console.error('private worker became ready after', Date.now() - started, 'ms; admission deadline is 5000ms');
    const result = await pending; pending = null;
    assert.equal(result.status, 0, fixtureResultContext(result));
    assert.match(result.stdout, /ADMITTED_LONG_COMMAND/u);
    assert.equal(gateResult(result.stdout).runner, HOST + '-drop', 'a ready runner is not canceled or duplicated locally');
    assert.equal(readFileSync(box.requests, 'utf8').trim().split('\n').length, 1);
  } catch (error) {
    const lines = existsSync(box.stderrLog) ? readFileSync(box.stderrLog, 'utf8').split('\n') : [];
    console.error('private worker diagnostics:', lines.filter(line => !line.startsWith('PULLBOARD_RUNNER_RESULT ')).slice(-8).map(line => line.slice(0, 500)).join('\n'));
    if (existsSync(box.requests)) console.error('private worker outcomes:', readFileSync(box.requests, 'utf8').split('\n').filter(Boolean).map(line => {
      const { call, workerStarted, code, signal } = JSON.parse(line);
      return { call, workerStarted, code, signal };
    }));
    throw error;
  } finally {
    held?.release();
    if (pending) await pending.catch(() => {});
    for (const [index, key] of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});

test('a busy runner is named at the deadline and fallback waits for a real local slot [C7,Q1,Q2]', async () => {
  const box = fixture({ dropFirst: false });
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  let held;
  let remote;
  let pending;
  try {
    held = await takeResource({ name: 'gate', scope: 'machine', root: box.repo, capacity: 1, agent: 'busy-local-holder' });
    const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'));
    remote = await takeResource({ name: 'gate', scope: 'machine', root: box.repo, capacity: 1,
      browser: true, browserCapacityProvider: () => 1, remote: true,
      runnerProvider: () => settings.runners, agent: 'real-remote-reservation' });
    assert.equal(remote.runner.host, HOST + '-drop');
    pending = runThroughGate(box.repo, box.env, 'node -e "console.log(\'BUSY_FALLBACK_LOCAL\')"', { item: 'busy-case', requests: box.requests });
    const queue = () => listResources({ scope: 'machine' }).find(resource => resource.name === 'gate');
    await observe(() => queue()?.line.some(row => row.item === 'busy-case' && row.runnerDeadline?.branch), 'busy-runner deadline facts with both real capacities held');
    const row = queue().line.find(waiter => waiter.item === 'busy-case');
    assert.match(row.runnerDeadline.branch, /local gate slots busy/u);
    assert.equal(row.runnerDeadline.runners[0].reason, 'busy');
    assert.equal(existsSync(box.starts), false, 'a busy reservation is never oversubscribed');
    held.release(); held = null;
    const result = await pending; pending = null;
    assert.equal(result.status, 0, fixtureResultContext(result));
    assert.match(result.stdout, /BUSY_FALLBACK_LOCAL/u);
    assert.equal(gateResult(result.stdout).runner, undefined);
    assert.match(result.stderr, new RegExp(HOST + '-drop: busy', 'u'));
    assert.equal(existsSync(box.starts), false, 'fallback does not retry the still-held remote reservation');
  } finally {
    held?.release(); remote?.release();
    if (pending) await pending.catch(() => {});
    for (const [index, key] of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});
