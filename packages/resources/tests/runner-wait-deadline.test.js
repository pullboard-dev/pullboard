/** Runner deadlines retain ordinary local admission and never create disabled capacity [C7,Q1,Q2]. */
import { executionServicesSource } from '../../../test/gate-execution-fixture.js';
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import {
  cleanupFixtureChildren,
  runFixtureChild,
  runFixtureChildAsync,
} from '../../../test/fixture-child.js';
import {
  cleanupToolingSnapshots,
  cli,
  committedToolingSnapshot,
  fixtureResultContext,
  gateResult,
  runThroughGate,
} from '../../../test/runner-tooling-fixture.js';
import {
  HOST,
  installSshStandIn,
  shellQuote,
} from '../../../test/runner-ssh-fixture.js';
import {
  listResources,
  takeResource,
} from '../src/shell/resources.js';

const e2e = createE2eHelpers();
// budget: measured stand-in boot allowance already used by runner-transport-lost; the actual deadline and fallback assertions remain exercised.
const STAND_IN_BOOT_BUDGET_MS = 8_000;
after(e2e.cleanup);
after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

/** Build the real loopback SSH transport in an isolated machine, with a short private deadline. */
function fixture({ hold = '', runnerWaitMs = 60, dropFirst = !hold, healthDown = false, transportDown = healthDown } = {}) {
  const box = e2e.project('true');
  const paths = Object.fromEntries(['bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(box.dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl');
  const starts = join(box.dir, 'starts.jsonl');
  const stderrLog = join(box.dir, 'worker-stderr.log');
  // The registration probe reads this machine's desktop; pin it to no desktop, as the runner's fixture host has (#1599).
  const noDesktop = join(box.dir, 'no-desktop-preload.cjs');
  writeFileSync(noDesktop, `const cp=require('node:child_process');const original=cp.spawnSync;
cp.spawnSync=function(command,...args){ if(command!=='/bin/launchctl') return original.call(this,command,...args);
  return {status:113,signal:null,stderr:'Could not find domain for fixture\\n'}; };
require('node:module').syncBuiltinESMExports();\n`);
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome,
    machineHome: paths.remoteMachine, requests, starts, hold, dropFirst, healthDown: transportDown, workerHealthDown: healthDown, stderrLog,
    registrationNodeOptions: `--require=${noDesktop}` });
  box.env.PATH = paths.bin + ':' + box.env.PATH;
  const added = cli(box.repo, box.env, 'runner', 'add', HOST + '-drop', '--slots', '1', '--browser', '1');
  assert.equal(added.status, 0, fixtureResultContext(added));
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  writeFileSync(settingsFile, JSON.stringify({ ...settings, gateSlots: 1, browserSlots: 1,
    gate: { ...settings.gate, runnerWaitMs, runnersFirst: false } }));
  return { ...box, requests, starts, stderrLog, settingsFile };
}

/**
 * Observe a real fixture phase, with cleanup owned by the caller rather than a production timeout override.
 * An infrastructure requeue renews the runner deadline by design (#1953), so a phase that follows one passes
 * a budget covering the admission deadline plus the renewed one.
 */
async function observe(predicate, description, budgetMs = 10_000) {
  const until = Date.now() + budgetMs; // budget: private Git and SSH startup; no production deadline extension.
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('fixture did not reach ' + description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('a first lost transport requeues the run onto the same runner without a quarantine or a deadline row [C7,Q1,Q2]', async () => {
  // Since da6ea0ede7 (resource-recovery.js runnerExcluded) one lost transport no longer quarantines a runner: only two
  // failed probes 30 s apart do, so inside the deadline the run is dispatched again rather than waiting on a dead host.
  const box = fixture({ runnerWaitMs: STAND_IN_BOOT_BUDGET_MS, healthDown: true });
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
    const module = pathToFileURL(join(import.meta.dirname, '../../gate/index.js')).href;
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

test('a registered runner that never answers is canceled at the deadline and the original run executes locally [C7,Q1,Q2]', async () => {
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


/** Run one isolated real pool case without changing the invoking machine's resource settings. */
async function withPrivateDeadlineMachine(box, action) {
  const keys = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = box.env[key];
  try { return await action(JSON.parse(readFileSync(box.settingsFile, 'utf8'))); }
  finally { keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }); }
}

/** Read only the bounded tail of an existing private diagnostic, never a whole result packet. */
function diagnosticTail(file) {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 16_384));
    const length = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

/** On failure retain actual setup/transport evidence without printing native result/base64 bodies. */
function lateDispatchDiagnostics(box) {
  const stderr = diagnosticTail(box.stderrLog).split('\n');
  console.error('late private worker diagnostics:', stderr.filter(line => !line.startsWith('PULLBOARD_RUNNER_RESULT ')
    && !line.startsWith('PULLBOARD_RUNNER_NEED ')).slice(-8).map(line => line.slice(0, 500)).join('\n'));
  const outcomes = diagnosticTail(box.requests).split('\n').filter(Boolean).slice(-4).map(line => {
    try {
      const { call, workerStarted, code, signal, dropped, spawnError } = JSON.parse(line);
      return { call, workerStarted, code, signal, dropped, spawnError };
    } catch { return { incomplete: true }; }
  });
  console.error('late private worker outcomes:', outcomes);
  console.error('late private worker phases:', diagnosticTail(box.requests + '.phases').slice(-500));
  const pool = listResources({ scope: 'machine' }).find(row => row.name === 'gate');
  console.error('late private gate state:', { holders: pool?.holders.length, waiters: pool?.line.length });
}

test('a first runner freed after the queue deadline executes with its captured startup budget and records the exception [C7,Q1,Q2]', async () => {
  const runnerWaitMs = 5_000; // budget: private worker source negotiation and READY, with an actual expired queue wait.
  const box = fixture({ runnerWaitMs, dropFirst: false });
  const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'));
  writeFileSync(box.settingsFile, JSON.stringify({ ...settings, gateSlots: 0, browserSlots: 0 }));
  await withPrivateDeadlineMachine(box, async current => {
    let held = await takeResource({ name: 'gate', root: box.repo, capacity: 0,
      remote: true, runnerOnly: true, runnerProvider: () => current.runners });
    let pending;
    const release = join(box.dir, 'release-runner'), released = join(box.dir, 'runner-released');
    try {
      const tooling = committedToolingSnapshot(join(import.meta.dirname, '../../..'), box.env);
      const gate = pathToFileURL(join(tooling, 'packages/gate/index.js')).href;
      const command = 'node -e "console.log(\'LATE_FIRST_DISPATCH_EXECUTED\')"';
      const script = `import {writeFileSync,existsSync} from 'node:fs';
import {withGateSlot,runProfiledShell} from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
let waited=false;
const run=await withGateSlot(${JSON.stringify(box.repo)},lease=>runProfiledShell(${JSON.stringify(box.repo)},${JSON.stringify(command)},{gateLease:lease}),{ executionServices,
  browser:false,runnerOnly:true,item:'late-first',agent:'late-first-fixture',
  onWait:async state=>{if(state.admitted||waited)return;waited=true;
    await new Promise(done=>setTimeout(done,${runnerWaitMs + 50}));
    writeFileSync(${JSON.stringify(release)},'queue deadline elapsed');
    while(!existsSync(${JSON.stringify(released)}))await new Promise(done=>setTimeout(done,10));},
  onReceipt:receipt=>console.log('LATE_FIRST_RECEIPT '+JSON.stringify(receipt))});
console.log(run.output);process.exitCode=run.isGreen?0:1;`;
      pending = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env: box.env, timeout: 20_000 }); // budget: private queue wait plus one captured startup budget and cleanup.
      await observe(() => existsSync(release), 'the queued first dispatch crossing its real deadline');
      held.release(); held = null;
      writeFileSync(released, 'the original real remote reservation released');
      const result = await pending; pending = null;
      if (result.status !== 0) lateDispatchDiagnostics(box);
      assert.equal(result.status, 0, fixtureResultContext(result));
      assert.match(result.stdout, /LATE_FIRST_DISPATCH_EXECUTED/u);
      const line = result.stdout.split('\n').find(row => row.startsWith('LATE_FIRST_RECEIPT '));
      assert.ok(line, 'the normal gate emitted its controller receipt');
      const receipt = JSON.parse(line.slice('LATE_FIRST_RECEIPT '.length));
      assert.equal(receipt.lateRunnerDispatch.budgetMs, runnerWaitMs, 'reuse the captured machine setting, not a new timeout');
      assert.equal(receipt.lateRunnerDispatch.host, HOST + '-drop');
      assert.ok(receipt.lateRunnerDispatch.admittedAt >= receipt.lateRunnerDispatch.queueDeadlineAt);
      assert.equal(receipt.lateRunnerDispatch.startupDeadlineAt - receipt.lateRunnerDispatch.admittedAt, runnerWaitMs);
      assert.equal(readFileSync(box.requests, 'utf8').trim().split('\n').length, 1, 'exactly one actual SSH dispatch');
      const pool = listResources({ scope: 'machine' }).find(row => row.name === 'gate');
      assert.equal(pool.holders.length + pool.line.length, 0, 'all original leases drain');
    } finally {
      held?.release();
      writeFileSync(released, 'cleanup releases the owned fixture barrier');
      if (pending) await pending;
    }
  });
});

test('an overdue runner-only request refuses busy capacity with its next step instead of oversubscribing [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const options = { name: 'gate', root: box.repo, capacity: 0, remote: true, runnerOnly: true,
      runnerProvider: () => settings.runners };
    // The holder takes the free runner on its first poll with a budget no loaded machine can outrun; at the fixture's 60ms a late first poll would count as an overdue late dispatch and its startup budget could expire, hiding the runner behind a non-busy reason.
    const held = await takeResource({ ...options, runnerWaitMs: 60_000 });
    try {
      await assert.rejects(takeResource({ ...options, runnerWaitMs: 60 }), error => error.code === 'RUNNER_WAIT_DEADLINE'
        && /busy/u.test(error.message) && /then retry/u.test(error.message));
      const pool = listResources({ scope: 'machine' }).find(row => row.name === 'gate');
      assert.equal(pool.line.length, 0, 'a refused overdue ticket is removed');
      assert.equal(existsSync(box.starts), false, 'a busy real reservation never starts SSH');
    } finally { held.release(); }
  });
});

test('a missed READY readmits the original ticket on a free runner without awaiting its recovery probe [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const runners = [...settings.runners, { ...settings.runners[0], host: HOST + '-second' }];
    let probeStarted = false, finishProbe;
    const pendingProbe = new Promise(done => { finishProbe = done; });
    const options = { name: 'gate', root: box.repo, capacity: 0, remote: true, runnerOnly: true,
      runnerProvider: () => runners, runnerWaitMs: 60,
      runnerHealthProbe: async () => { probeStarted = true; return pendingProbe; },
      runnerIdleProbe: async () => { probeStarted = true; return pendingProbe; } };
    let lease = await takeResource(options);
    const token = lease.token;
    const firstHost = lease.runner.host;
    try {
      await new Promise(done => setTimeout(done, 80)); // budget: cross the declared private 60ms readiness deadline before requeueing.
      lease = await lease.requeueRunner('worker-unresponsive', {
        diagnostic: { reason: 'admission-deadline' } });
      assert.notEqual(lease.runner.host, firstHost);
      assert.equal(lease.token, token, 'the retry retains the original ticket identity');
      assert.equal(probeStarted, true, 'the unready worker is probed independently of admission');
      const pool = listResources({ scope: 'machine' }).find(row => row.name === 'gate');
      assert.equal(pool.line.length, 0, 'the free compatible runner is taken in the first dispatch cycle');
      const remote = listResources({ scope: 'machine' }).find(row => row.name === `runner:${lease.runner.host}`);
      assert.equal(remote.holders.length, 1, 'the actual remote slot remains reserved');
    } finally { lease.release(); finishProbe({ healthy: false, reason: 'worker still unready' }); }
  });
});

test('a failed late dispatch cannot buy another startup budget on a different free runner [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const runners = [...settings.runners, { ...settings.runners[0], host: HOST + '-second' }];
    const options = { name: 'gate', root: box.repo, capacity: 0, remote: true, runnerOnly: true,
      runnerProvider: () => runners, runnerWaitMs: 60 };
    let first = await takeResource(options), second = await takeResource(options), late;
    try {
      let waited = false;
      late = await takeResource({ ...options, onWait: async state => {
        if (state.admitted || waited) return;
        waited = true;
        await new Promise(done => setTimeout(done, 80)); // budget: cross only this private queue's 60ms deadline.
        first.release(); first = null;
      } });
      assert.equal(late.runner.host, runners[0].host);
      assert.equal(late.lateRunnerDispatch.budgetMs, 60);
      second.release(); second = null;
      const requeued = late.requeueRunner('transport-lost', { quarantine: false }); // a quarantined requeue starts a fresh attempt on purpose (10d8e44f17, #2657) late = null;
      await assert.rejects(requeued, { code: 'RUNNER_WAIT_DEADLINE' }, 'the same original request has spent its one late start');
      const pool = listResources({ scope: 'machine' }).find(row => row.name === 'gate');
      assert.equal(pool.holders.length + pool.line.length, 0, 'refusal cleans the transferred original ticket');
    } finally { first?.release(); second?.release(); late?.release(); }
  });
});

test('a late first dispatch cannot jump an older compatible runner waiter [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const options = { name: 'gate', root: box.repo, capacity: 0, remote: true, runnerOnly: true,
      runnerProvider: () => settings.runners };
    let held = await takeResource(options), admitted;
    let signalQueued, releaseQueue, observedWait;
    const queued = new Promise(done => { signalQueued = done; });
    const barrier = new Promise(done => { releaseQueue = done; });
    const older = takeResource({ ...options, runnerWaitMs: 5_000, agent: 'older-runner-waiter', onWait: async state => {
      if (!state.admitted) { observedWait = state.runnerWait; signalQueued(); await barrier; }
    } });
    try {
      await queued;
      assert.equal(observedWait.runners[0].slots.free, 0);
      assert.equal(observedWait.runners[0].holders.length, 1);
      assert.equal(observedWait.runners[0].browser.total, 1);
      let waited = false;
      await assert.rejects(takeResource({ ...options, runnerWaitMs: 60, agent: 'later-runner-waiter', onWait: async state => {
        if (state.admitted || waited) return;
        waited = true;
        await new Promise(done => setTimeout(done, 80)); // budget: expire only the later private request.
        held.release(); held = null;
      } }), { code: 'RUNNER_WAIT_DEADLINE' }, 'a free runner belongs to the earlier compatible ticket');
      releaseQueue();
      admitted = await older;
      assert.equal(admitted.runner.host, settings.runners[0].host);
      assert.equal(admitted.lateRunnerDispatch, undefined, 'the older request retains its own unexpired clock');
    } finally {
      held?.release(); releaseQueue();
      admitted ??= await older;
      admitted?.release();
    }
  });
});

test('a waiting older ticket reserves only one of two free runner slots [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const options = { name: 'gate', root: box.repo, capacity: 0, remote: true, runnerOnly: true,
      runnerProvider: () => settings.runners.map(runner => ({ ...runner, slots: 2 })) };
    let first = await takeResource(options), second = await takeResource(options), later, admitted;
    let signalQueued, releaseQueue;
    const queued = new Promise(done => { signalQueued = done; });
    const barrier = new Promise(done => { releaseQueue = done; });
    const older = takeResource({ ...options, runnerWaitMs: 5_000, agent: 'older-idle-slot', onWait: async state => {
      if (!state.admitted) { signalQueued(); await barrier; }
    } });
    try {
      await queued;
      first.release(); first = null;
      second.release(); second = null;
      later = await takeResource({ ...options, runnerWaitMs: 1_000, agent: 'later-idle-slot' });
      assert.equal(later.runner.host, settings.runners[0].host, 'the spare slot starts the later eligible request');
      releaseQueue();
      admitted = await older;
      assert.equal(admitted.runner.host, later.runner.host, 'one slot remains reserved for the earlier ticket');
    } finally {
      first?.release(); second?.release(); later?.release(); releaseQueue();
      admitted ??= await older;
      admitted?.release();
    }
  });
});

test('runner-only browser refusal retries with a browser lease [C7,Q1,Q2]', async () => {
  const box = fixture({ dropFirst: false });
  const gateUrl = pathToFileURL(join(process.cwd(), 'packages/gate/index.js')).href;
  const source = `import { withGateSlot } from ${JSON.stringify(gateUrl)};
${executionServicesSource(gateUrl)}
let calls = 0;
const result = await withGateSlot(process.cwd(), lease => {
  calls += 1;
  if (calls === 1) {
    if (lease.browser) throw new Error('first attempt unexpectedly has browser capacity');
    const error = new Error('authenticated runner refusal');
    error.code = 'RUNNER_BROWSER_SLOT_REQUIRED';
    error.runnerAttempt = { host: lease.runner.host, exitCode: 1, output: 'refused' };
    throw error;
  }
  return { browser: lease.browser, host: lease.runner.host };
}, { executionServices, remote: true, runnerOnly: true, browser: false, runnerWaitMs: 5000 });
process.stdout.write(JSON.stringify({ calls, result }));`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.calls, 2);
  assert.equal(outcome.result.browser, true);
  assert.equal(outcome.result.runnerAttempt.output, 'refused');
});

test('a direct flexible request prefers an idle browser-free runner [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const runners = [{ ...settings.runners[0], host: HOST + '-browser', slots: 1, browser: 1 },
      { ...settings.runners[0], host: HOST + '-plain', slots: 1, browser: 0 }];
    const options = { name: 'gate', root: box.repo, capacity: 1, browserCapacity: 1, remote: true, runnerOnly: true,
      runnerProvider: () => runners };
    const flexible = await takeResource(options);
    let browser;
    try {
      assert.equal(flexible.runner.host, HOST + '-plain', 'browser capacity stays free without a queued browser waiter');
      browser = await takeResource({ ...options, browser: true, runnerWaitMs: 1_000 });
      assert.equal(browser.runner.host, HOST + '-browser');
    } finally { browser?.release(); flexible.release(); }
  });
});

test('an older flexible waiter leaves a scarce browser host for a browser waiter [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const runners = [{ ...settings.runners[0], host: HOST + '-browser', slots: 1, browser: 1 },
      { ...settings.runners[0], host: HOST + '-plain', slots: 1, browser: 0 }];
    const options = { name: 'gate', root: box.repo, capacity: 1, browserCapacity: 1, remote: true, runnerOnly: true,
      runnerProvider: () => runners };
    let first = await takeResource(options), second = await takeResource(options), later, admitted;
    let signalQueued, releaseQueue;
    const queued = new Promise(done => { signalQueued = done; });
    const barrier = new Promise(done => { releaseQueue = done; });
    const older = takeResource({ ...options, runnerWaitMs: 5_000, onWait: async state => {
      if (!state.admitted) { signalQueued(); await barrier; }
    } });
    try {
      await queued;
      first.release(); first = null;
      second.release(); second = null;
      later = await takeResource({ ...options, browser: true, runnerWaitMs: 1_000 });
      assert.equal(later.runner.host, HOST + '-browser');
      releaseQueue();
      admitted = await older;
      assert.equal(admitted.runner.host, HOST + '-plain');
    } finally {
      first?.release(); second?.release(); later?.release(); releaseQueue();
      admitted ??= await older;
      admitted?.release();
    }
  });
});

test('a suite starts promptly on a mostly idle runner fleet [C7,Q1,Q2]', async () => {
  const box = fixture();
  await withPrivateDeadlineMachine(box, async settings => {
    const runners = Array.from({ length: 5 }, (_, index) => ({ ...settings.runners[0], host: `${HOST}-fleet-${index}`, slots: 9, browser: 9 }));
    const options = { name: 'gate', root: box.repo, capacity: 1, browserCapacity: 1, remote: true,
      runnerOnly: true, runnerProvider: () => runners };
    const held = [];
    let suite;
    try {
      for (let index = 0; index < 12; index += 1) held.push(await takeResource(options));
      suite = await takeResource({ ...options, browser: true, kind: 'suite', runnerWaitMs: 5_000,
        onWait: state => { if (!state.admitted) assert.fail('a mostly idle fleet must admit without queueing'); } });
      assert.ok(suite.runner);
    } finally { suite?.release(); for (const lease of held) lease.release(); }
  });
});
