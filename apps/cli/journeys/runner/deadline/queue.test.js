/** Runner deadline queue cases, split from deadline.test.js so each file stays under its time budget [C7,Q1,Q2]. */
import { executionServicesSource } from '../../../tests/fixtures/gate/execution.js';
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
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import {
  committedToolingSnapshot,
  fixtureResultContext,
  gateResult,
  runThroughGate,
} from '../../../tests/fixtures/runner/tooling.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import {
  listResources,
  takeResource,
} from '../../../../../packages/resources/index.js';
import {
  STAND_IN_BOOT_BUDGET_MS,
  fixture,
  observe,
  withPrivateDeadlineMachine,
  lateDispatchDiagnostics,
} from '../../../tests/fixtures/runner/deadline.js';

test('clause 1: an executing runner command keeps its test budget after the admission deadline [C7]', async () => {
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


test('clause 1: a first runner freed after the queue deadline executes with its captured startup budget and records the exception [C7,Q1,Q2]', async () => {
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
      const tooling = committedToolingSnapshot(join(import.meta.dirname, '../../../..'), box.env);
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
      assert.equal(receipt.lateRunnerDispatch.budgetMs, 90_000, 'a fixed startup budget, not the queue wait setting [3832]');
      assert.equal(receipt.lateRunnerDispatch.host, HOST + '-drop');
      assert.ok(receipt.lateRunnerDispatch.admittedAt >= receipt.lateRunnerDispatch.queueDeadlineAt);
      assert.equal(receipt.lateRunnerDispatch.startupDeadlineAt - receipt.lateRunnerDispatch.admittedAt, 90_000);
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
      assert.equal(late.lateRunnerDispatch.budgetMs, 90_000);
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
  // The private machine setting is the child's startup deadline; the 60 ms default expired under runner load (load average 19 on 12 CPUs).
  const box = fixture({ dropFirst: false, runnerWaitMs: STAND_IN_BOOT_BUDGET_MS });
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
