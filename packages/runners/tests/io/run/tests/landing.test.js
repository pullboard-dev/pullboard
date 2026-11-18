/** @pullboard-test-input source-tree */
/** The production test runner stops a landing run at its first failing file and owns its cleanup [C7,V4]. */
import { awaitNestedPhase } from '../../../../../gate/index.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { startFixtureChild } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../gate/tests/fixtures/child.js';
import { focusedPoolSnapshot } from '../../../fixtures/pool.js';
import { waitForFixtureProcessDrain } from '../../../fixtures/landing-run.js';
import { waitForFixtureProcessRunning } from '../../../fixtures/landing-run.js';
import { fixtureProcessIdentity } from '../../../fixtures/landing-run.js';
import { signalFixtureProcess } from '../../../fixtures/landing-run.js';
import { waitForFixtureIdentityDrain } from '../../../fixtures/landing-run.js';
import { waitForFixtureMarker } from '../../../fixtures/landing-run.js';
import { makeLandingStopFixture } from '../../../fixtures/landing-run.js';
import { installLandingPidReusePsShim } from '../../../fixtures/landing-run.js';
import { installLandingSignalFailureShim } from '../../../fixtures/landing-run.js';

test('runners.landing.a-failed-test-completion-without-a: a failed test completion without a type still stops a landing run [C7,V4]', async t => {
  const fixture = makeLandingStopFixture(t);
  const preload = join(fixture.root, 'untyped-completion.mjs');
  const delivered = join(fixture.root, 'untyped-completion-delivered');
  writeFileSync(preload, `import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
// Prefix-only node:test exports are not updated by syncBuiltinESMExports.
// Intercept the real listener's event while preserving the reporter stream's original object.
if (process.argv[1] === ${JSON.stringify(fixture.runner)}) {
  const originalEmit = EventEmitter.prototype.emit;
  /** Deliver an untyped completion only for the intentional failure in this private fixture. */
  EventEmitter.prototype.emit = function(type, ...args) {
    const data = args[0];
    if (type === 'test:complete' && data?.file === ${JSON.stringify(join(fixture.root, 'test/02-failing.test.js'))}
      && data.details?.passed === false
      && (data.details.type === undefined || data.details.type === 'test')) {
      const details = { ...data.details };
      delete details.type;
      args[0] = { ...data, details };
      const result = originalEmit.call(this, type, ...args);
      writeFileSync(${JSON.stringify(delivered)}, 'delivered');
      return result;
    }
    // Keep failure reporting, but isolate this regression from the newer file-summary fallback.
    if (type === 'test:summary' && data?.file === ${JSON.stringify(join(fixture.root, 'test/02-failing.test.js'))}
      && data.success === false) {
      const summary = { ...data };
      delete summary.file;
      args[0] = summary;
    }
    return originalEmit.call(this, type, ...args);
  };
}
`);
  const env = {
    ...process.env,
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    PULLBOARD_LANDING_RUN: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' '),
    PULLBOARD_C7_SIBLING_STARTED: fixture.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: fixture.siblingFinished,
    PULLBOARD_C7_FAILURE: fixture.failure,
    PULLBOARD_C7_RELEASE: fixture.release,
    PULLBOARD_C7_QUEUED: fixture.queued,
    PULLBOARD_C7_WORKER_MARKER: fixture.workerMarker,
    PULLBOARD_C7_CHILD_READY: fixture.childReady,
    PULLBOARD_C7_CHILD_PID: fixture.childPid,
    PULLBOARD_C7_CHILD_DRAINED: fixture.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: fixture.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: fixture.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: fixture.failChildDrained,
  };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, '--test-concurrency=2'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 1, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(existsSync(delivered), 'the actual failing completion reached the runner without a type');
  assert.ok(existsSync(fixture.failure), 'the intentional failure completed');
  assert.ok(existsSync(fixture.siblingStarted), 'the sibling was active before the failure');
  assert.equal(existsSync(fixture.siblingFinished), false, 'the untyped completion interrupted the active sibling');
  assert.equal(existsSync(fixture.queued), false, 'no queued sentinel started after the untyped failure');
  assert.equal(existsSync(fixture.release), false, 'no queued sentinel released the active sibling');
  for (const [pid, drained] of [[fixture.childPid, fixture.childDrained], [fixture.failChildPid, fixture.failChildDrained]]) {
    assert.ok(existsSync(drained), 'the owned detached child acknowledged cleanup');
    assert.ok(await waitForFixtureProcessDrain(readFileSync(pid, 'utf8').trim()), 'the owned detached child exited before return');
  }
  assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /Landing gate stopped early after .*02-failing\.test\.js/u);
});

test('runners.landing.a-landing-run-stops-at-the: a landing run stops at the first failing file [C7,V4]', async t => {
  const unrelatedRoot = mkdtempSync(join(tmpdir(), 'pullboard-landing-unrelated-'));
  const unrelatedReady = join(unrelatedRoot, 'ready');
  const unrelatedDrained = join(unrelatedRoot, 'drained');
  const unrelated = spawn(process.execPath, ['-e', `const fs=require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(unrelatedDrained)}, 'drained'); process.exit(0); }); fs.writeFileSync(${JSON.stringify(unrelatedReady)}, 'ready'); setInterval(() => {}, 1000);`], {
    detached: true, stdio: 'ignore',
  });
  t.after(() => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGKILL');
    rmSync(unrelatedRoot, { recursive: true, force: true });
  });
  const unrelatedDeadline = Date.now() + 2000;
  while (!existsSync(unrelatedReady) && Date.now() < unrelatedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(unrelatedReady), 'the unrelated process started before the landing run');
  const fixture = makeLandingStopFixture(t);
  const env = {
    ...process.env,
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_C7_SIBLING_STARTED: fixture.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: fixture.siblingFinished,
    PULLBOARD_C7_FAILURE: fixture.failure,
    PULLBOARD_C7_RELEASE: fixture.release,
    PULLBOARD_C7_QUEUED: fixture.queued,
    PULLBOARD_C7_WORKER_MARKER: fixture.workerMarker,
    PULLBOARD_C7_CHILD_READY: fixture.childReady,
    PULLBOARD_C7_CHILD_PID: fixture.childPid,
    PULLBOARD_C7_CHILD_DRAINED: fixture.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: fixture.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: fixture.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: fixture.failChildDrained,
  };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const stopped = runFixtureChild(process.execPath, [fixture.runner, '--test-concurrency=2'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 15000,
  });
  const stoppedOutput = `${stopped.stdout ?? ''}\n${stopped.stderr ?? ''}`;
  assert.equal(stopped.status, 1, `${stopped.context}\n${stoppedOutput}`);
  assert.ok(existsSync(fixture.failure), 'the intentional failing test ran');
  assert.ok(existsSync(fixture.siblingStarted), 'the earlier sibling was active when failure completed');
  assert.ok(existsSync(fixture.childReady), 'the active sibling launched its detached child');
  assert.equal(existsSync(fixture.siblingFinished), false, 'the active sibling was interrupted');
  assert.equal(existsSync(fixture.queued), false, 'the queued sentinel never started');
  assert.equal(existsSync(fixture.release), false, 'no queued sentinel released the active sibling');
  assert.ok(existsSync(fixture.childDrained), 'the detached child handled the runner cleanup signal');
  assert.ok(await waitForFixtureProcessDrain(readFileSync(fixture.childPid, 'utf8').trim()), 'the detached child exited before the gate returned');
  assert.ok(existsSync(fixture.failChildReady), 'the failing worker launched its own detached child');
  assert.ok(existsSync(fixture.failChildDrained), 'the runner captured and drained the failing worker child before it was reparented');
  assert.ok(await waitForFixtureProcessDrain(readFileSync(fixture.failChildPid, 'utf8').trim()), 'the failing worker child exited before the gate returned');
  assert.ok(await waitForFixtureProcessRunning(unrelated.pid), 'an unrelated detached process remains alive');
  assert.equal(existsSync(unrelatedDrained), false, 'the unrelated process received no cleanup signal');
  unrelated.kill('SIGTERM');
  assert.ok(await waitForFixtureProcessDrain(unrelated.pid), 'the regression cleaned up its unrelated process');
  assert.ok(existsSync(unrelatedDrained), 'the unrelated process acknowledged test cleanup');
  assert.match(stoppedOutput, /Landing gate stopped early after .*02-failing\.test\.js/u);
  assert.match(stoppedOutput, /Triggering test error:[\s\S]*intentional landing stop \[C7\]/u);
  assert.match(stoppedOutput, /Files not run: .*0[3-8]-queued\.test\.js/u);
  assert.equal(readFileSync(fixture.workerMarker, 'utf8'), '0', 'test workers do not inherit the landing mode');

  const inProcess = makeLandingStopFixture(t);
  const inProcessEnv = {
    ...env,
    PULLBOARD_MACHINE_HOME: join(inProcess.root, 'machine'),
    PULLBOARD_C7_SIBLING_STARTED: inProcess.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: inProcess.siblingFinished,
    PULLBOARD_C7_FAILURE: inProcess.failure,
    PULLBOARD_C7_RELEASE: inProcess.release,
    PULLBOARD_C7_QUEUED: inProcess.queued,
    PULLBOARD_C7_WORKER_MARKER: inProcess.workerMarker,
    PULLBOARD_C7_CHILD_READY: inProcess.childReady,
    PULLBOARD_C7_CHILD_PID: inProcess.childPid,
    PULLBOARD_C7_CHILD_DRAINED: inProcess.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: inProcess.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: inProcess.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: inProcess.failChildDrained,
  };
  const inProcessStopped = runFixtureChild(process.execPath,
    [inProcess.runner, '--test-isolation=none', '--test-concurrency=2'], {
      cwd: inProcess.root, env: inProcessEnv, encoding: 'utf8', timeout: 15000,
    });
  const inProcessOutput = `${inProcessStopped.stdout ?? ''}\n${inProcessStopped.stderr ?? ''}`;
  assert.equal(inProcessStopped.status, 1, `${inProcessStopped.context}\n${inProcessOutput}`);
  assert.match(inProcessOutput, /landing gate early-stop requires --test-isolation=process/u);
  assert.equal(existsSync(inProcess.siblingStarted), false, 'no-isolation landing was refused before any file started');
  assert.equal(existsSync(inProcess.queued), false, 'no-isolation landing did not start queued sentinels');

  const ordinary = makeLandingStopFixture(t);
  const ordinaryEnv = {
    ...env,
    PULLBOARD_MACHINE_HOME: join(ordinary.root, 'machine'),
    PULLBOARD_LANDING_RUN: '0',
    PULLBOARD_C7_SIBLING_STARTED: ordinary.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: ordinary.siblingFinished,
    PULLBOARD_C7_FAILURE: ordinary.failure,
    PULLBOARD_C7_RELEASE: ordinary.release,
    PULLBOARD_C7_QUEUED: ordinary.queued,
    PULLBOARD_C7_WORKER_MARKER: ordinary.workerMarker,
    PULLBOARD_C7_CHILD_READY: ordinary.childReady,
    PULLBOARD_C7_CHILD_PID: ordinary.childPid,
    PULLBOARD_C7_CHILD_DRAINED: ordinary.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: ordinary.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: ordinary.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: ordinary.failChildDrained,
  };
  // The failing worker drains its own child before it exits, so its slot stays held until that child ends; end it once it is up.
  const normalChild = startFixtureChild(process.execPath, [ordinary.runner, '--test-concurrency=2',
    'test/01-sibling.test.js', 'test/02-failing.test.js', ...ordinary.queuedFiles], {
    cwd: ordinary.root, env: ordinaryEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const normal = { stdout: '', stderr: '', context: 'ordinary run' };
  normalChild.stdout?.setEncoding('utf8').on('data', part => { normal.stdout += part; });
  normalChild.stderr?.setEncoding('utf8').on('data', part => { normal.stderr += part; });
  const normalClosed = new Promise(resolve => normalChild.once('close', (code, signal) => resolve({ code, signal })));
  await waitForFixtureMarker(ordinary.failChildReady, 'the failing file launched its detached child');
  process.kill(Number(readFileSync(ordinary.failChildPid, 'utf8').trim()), 'SIGTERM');
  normal.status = (await normalClosed).code;
  assert.equal(normal.status, 1, `${normal.context}\n${normal.stdout}\n${normal.stderr}`);
  assert.ok(existsSync(ordinary.siblingFinished), `ordinary runs wait for active sibling files\n${normal.context}\nstdout: ${normal.stdout ?? ''}`);
  assert.ok(existsSync(ordinary.queued), 'ordinary runs continue scheduling queued files');
  assert.ok(existsSync(ordinary.childDrained), 'ordinary test cleanup also drains its detached child');
  assert.ok(await waitForFixtureProcessDrain(readFileSync(ordinary.childPid, 'utf8').trim()), 'ordinary test cleanup waited for its child to stop');
  assert.ok(existsSync(ordinary.failChildReady), 'the failing worker launched its detached child during an ordinary run');
  assert.ok(await waitForFixtureProcessDrain(readFileSync(ordinary.failChildPid, 'utf8').trim()), 'ordinary fixture child was drained');
  assert.ok(existsSync(ordinary.failChildDrained), 'the regression cleaned up the ordinary failing-worker child');
  assert.doesNotMatch(`${normal.stdout ?? ''}\n${normal.stderr ?? ''}`, /stopped early/u);

  await t.test('a reused worker PID cannot adopt an unrelated process subtree', async t => {
    const outsiderRoot = mkdtempSync(join(tmpdir(), 'pullboard-landing-pid-reuse-'));
    const outsiderReady = join(outsiderRoot, 'ready');
    const outsiderDrained = join(outsiderRoot, 'drained');
    const outsider = spawn(process.execPath, ['-e', `const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(outsiderDrained)},'drained');process.exit(0)});fs.writeFileSync(${JSON.stringify(outsiderReady)},'ready');setInterval(()=>{},1000);`], {
      detached: true, stdio: 'ignore',
    });
    await waitForFixtureMarker(outsiderReady, 'the unrelated process started');
    const outsiderIdentity = fixtureProcessIdentity(outsider.pid);
    assert.ok(outsiderIdentity, 'the unrelated process has a capturable cleanup identity');
    const cleanupOutsider = async () => {
      signalFixtureProcess(outsiderIdentity, 'SIGTERM');
      await waitForFixtureIdentityDrain(outsiderIdentity);
      rmSync(outsiderRoot, { recursive: true, force: true });
    };
    t.after(cleanupOutsider);

    const reused = makeLandingStopFixture(t);
    const psShim = installLandingPidReusePsShim(reused, outsider.pid);
    const injected = join(reused.root, 'pid-reuse-injected');
    const env = {
      ...process.env,
      PATH: [psShim, process.env.PATH].filter(Boolean).join(delimiter),
      PULLBOARD_MACHINE_HOME: join(reused.root, 'machine'),
      PULLBOARD_LANDING_RUN: '1',
      PULLBOARD_C7_UNRELATED_PID: String(outsider.pid),
      PULLBOARD_C7_PID_REUSE_INJECTED: injected,
      PULLBOARD_C7_SIBLING_STARTED: reused.siblingStarted,
      PULLBOARD_C7_SIBLING_FINISHED: reused.siblingFinished,
      PULLBOARD_C7_FAILURE: reused.failure,
      PULLBOARD_C7_RELEASE: reused.release,
      PULLBOARD_C7_QUEUED: reused.queued,
      PULLBOARD_C7_WORKER_MARKER: reused.workerMarker,
      PULLBOARD_C7_CHILD_READY: reused.childReady,
      PULLBOARD_C7_CHILD_PID: reused.childPid,
      PULLBOARD_C7_CHILD_DRAINED: reused.childDrained,
      PULLBOARD_C7_FAIL_CHILD_READY: reused.failChildReady,
      PULLBOARD_C7_FAIL_CHILD_PID: reused.failChildPid,
      PULLBOARD_C7_FAIL_CHILD_DRAINED: reused.failChildDrained,
    };
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
    const result = runFixtureChild(process.execPath, [reused.runner, '--test-concurrency=2'], {
      cwd: reused.root, env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 1, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.ok(existsSync(injected), 'the process-table fixture presented an old worker PID with a different start identity');
    assert.ok(await waitForFixtureProcessRunning(outsider.pid), 'the unrelated process stayed alive after stale-root cleanup');
    assert.equal(existsSync(outsiderDrained), false, 'a reused worker PID did not adopt and signal the unrelated subtree');
    assert.ok(existsSync(reused.failChildDrained), 'the runner still drained its actual failing worker child');
  });

  await t.test('a failed cleanup signal keeps the gate slot until its child exits', async t => {
    const held = makeLandingStopFixture(t);
    const machine = join(held.root, 'machine');
    mkdirSync(machine);
    writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
    const signalFailure = join(held.root, 'signal-failure');
    const shim = installLandingSignalFailureShim(held);
    const baseEnv = {
      ...process.env,
      PULLBOARD_MACHINE_HOME: machine,
      PULLBOARD_LANDING_RUN: '1',
      PULLBOARD_C7_HOLD_FAIL_CHILD: '1',
      PULLBOARD_C7_SPAWN_LATE_CHILD_ON_TERM: '1',
      PULLBOARD_C7_RUNNER_PATH: held.runner,
      PULLBOARD_C7_SIGNAL_FAILURE: signalFailure,
      PULLBOARD_C7_FAIL_CHILD_RELEASE: held.failChildRelease,
      PULLBOARD_C7_SIBLING_STARTED: held.siblingStarted,
      PULLBOARD_C7_SIBLING_FINISHED: held.siblingFinished,
      PULLBOARD_C7_FAILURE: held.failure,
      PULLBOARD_C7_RELEASE: held.release,
      PULLBOARD_C7_QUEUED: held.queued,
      PULLBOARD_C7_WORKER_MARKER: held.workerMarker,
      PULLBOARD_C7_CHILD_READY: held.childReady,
      PULLBOARD_C7_CHILD_PID: held.childPid,
      PULLBOARD_C7_CHILD_DRAINED: held.childDrained,
      PULLBOARD_C7_FAIL_CHILD_READY: held.failChildReady,
      PULLBOARD_C7_FAIL_CHILD_PID: held.failChildPid,
      PULLBOARD_C7_FAIL_CHILD_DRAINED: held.failChildDrained,
      PULLBOARD_C7_LATE_CHILD_READY: held.lateChildReady,
      PULLBOARD_C7_LATE_CHILD_PID: held.lateChildPid,
      PULLBOARD_C7_LATE_CHILD_DRAINED: held.lateChildDrained,
      PULLBOARD_C7_LATE_CHILD_RELEASE: held.lateChildRelease,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(shim).href}`].filter(Boolean).join(' '),
    };
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete baseEnv[key];

    const landing = startFixtureChild(process.execPath, [held.runner, '--test-concurrency=2'], {
      cwd: held.root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let landingOutput = '';
    landing.stdout?.setEncoding('utf8').on('data', part => { landingOutput += part; });
    landing.stderr?.setEncoding('utf8').on('data', part => { landingOutput += part; });
    const landingClosed = new Promise(resolve => landing.once('close', (code, signal) => resolve({ code, signal })));
    let waiter;
    let waiterClosed;
    let waiterStarted = false;
    let waiterReadyFile = null;
    let failChildIdentity = null;
    let lateChildIdentity = null;
    try {
      await awaitNestedPhase(landing, async () => {
        await waitForFixtureMarker(held.failChildReady, 'the failing file launched its held child');
        failChildIdentity = fixtureProcessIdentity(readFileSync(held.failChildPid, 'utf8').trim());
        assert.ok(failChildIdentity, 'the owned child has a capturable cleanup identity');
        waiterReadyFile = join(held.root, 'competing-gate-started');
        const resourceModule = fileURLToPath(new URL('../../../../../resources/index.js', import.meta.url));
        const waiterSource = `import { takeResource } from ${JSON.stringify(resourceModule)}; import { writeFileSync } from 'node:fs'; const lease = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: ${JSON.stringify(held.root)}, agent: 'cleanup-drain-waiter' }); writeFileSync(${JSON.stringify(waiterReadyFile)}, 'started'); lease.release();`;
        waiter = startFixtureChild(process.execPath, ['--input-type=module', '-e', waiterSource], {
          cwd: held.root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'],
        });
        waiterClosed = new Promise(resolve => waiter.once('close', (code, signal) => resolve({ code, signal })));

        let queued = false;
        const handshakeDeadline = Date.now() + 10000;
        while (!existsSync(held.lateChildDrained) && !existsSync(waiterReadyFile) && Date.now() < handshakeDeadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(existsSync(signalFailure), 'the first owned SIGTERM failed as injected');
        assert.ok(existsSync(held.failChildDrained), 'the original owned child handled TERM and spawned a late detached child');
        assert.ok(existsSync(held.lateChildReady), 'the late detached child reached its ready handshake');
        assert.ok(existsSync(held.lateChildDrained), 'the live receipt set grew and cleanup reached the late child');
        lateChildIdentity = fixtureProcessIdentity(readFileSync(held.lateChildPid, 'utf8').trim());
        assert.ok(lateChildIdentity, 'the late child has a capturable cleanup identity');
        assert.equal(existsSync(waiterReadyFile), false, 'no competing gate action started while descendant drain was unresolved');
        const queueDeadline = Date.now() + 10000;
        while (!queued && !existsSync(waiterReadyFile) && Date.now() < queueDeadline) {
          queued = focusedPoolSnapshot(machine)?.line.some(row => row.agent === 'cleanup-drain-waiter') ?? false;
          if (!queued) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(queued, 'the competing gate action appeared in the queue while the late child remained held');
        assert.equal(existsSync(waiterReadyFile), false, 'the queued gate action has not entered before the child release');

        writeFileSync(held.lateChildRelease, 'allow exit');
        writeFileSync(held.failChildRelease, 'allow exit');
      });
      const [landingResult, waiterResult] = await Promise.all([landingClosed, waiterClosed]);
      waiterStarted = Boolean(waiterReadyFile) && existsSync(waiterReadyFile);
      assert.equal(landingResult.code, 1, `${landingOutput}\n${landingResult.signal ?? ''}`);
      assert.equal(landingResult.signal, null);
      assert.ok(landingOutput.includes('owned descendants drained after cleanup error: injected one-shot signal failure'), landingOutput);
      assert.deepEqual(waiterResult, { code: 0, signal: null });
      assert.ok(waiterStarted, 'the queued gate action started after owned child exit was confirmed');
    } finally {
      try { writeFileSync(held.failChildRelease, 'allow exit'); } catch { /* Fixture teardown may already remove it. */ }
      try { writeFileSync(held.lateChildRelease, 'allow exit'); } catch { /* Fixture teardown may already remove it. */ }
      if (failChildIdentity) signalFixtureProcess(failChildIdentity, 'SIGTERM');
      if (lateChildIdentity) signalFixtureProcess(lateChildIdentity, 'SIGTERM');
      if (landing.exitCode === null && landing.signalCode === null) landing.kill('SIGTERM');
      if (waiter && waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGTERM');
      if (landingClosed) await Promise.race([landingClosed, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (waiterClosed) await Promise.race([waiterClosed, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (failChildIdentity) await waitForFixtureIdentityDrain(failChildIdentity);
      if (lateChildIdentity) await waitForFixtureIdentityDrain(lateChildIdentity);
    }
  });
});

for (const code of ['EPERM', 'ESRCH']) {
  test(`a landing cleanup kill that answers ${code} for a child already gone counts as gone and is logged [C7]`, async t => {
    const held = makeLandingStopFixture(t);
    const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(held.root, 'machine'), PULLBOARD_LANDING_RUN: '1', PULLBOARD_C7_SIGNAL_GONE: code,
      PULLBOARD_C7_RUNNER_PATH: held.runner, PULLBOARD_C7_SIGNAL_FAILURE: join(held.root, 'signal-failure'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(installLandingSignalFailureShim(held)).href}`].filter(Boolean).join(' ') };
    for (const [key, path] of Object.entries(held)) if (typeof path === 'string' && !['root', 'runner'].includes(key)) env['PULLBOARD_C7_' + key.replace(/[A-Z]/gu, c => '_' + c).toUpperCase()] = path;
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
    const result = runFixtureChild(process.execPath, [held.runner, '--test-concurrency=2'], { cwd: held.root, env, encoding: 'utf8', timeout: 30000 });
    const output = `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.ok(existsSync(join(held.root, 'signal-failure')), 'the cleanup kill answered as injected\n' + output);
    assert.match(output, new RegExp(`run-tests: kill \\d+ answered ${code}; that process is gone or no longer ours, so it counts as gone`, 'u'));
    assert.doesNotMatch(output, /drained after cleanup error/u, 'a gone child is never a cleanup error');
  });
}
