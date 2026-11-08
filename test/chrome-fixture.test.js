// pullboard: browser
/** @pullboard-test-gui */
/** The shared Chrome fixture bounds startup and removes profiles only after the owned process group exits [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { test } from 'node:test';
import { createEvaluator, createSender, createWaiter, findChromeExecutable, launchChromeProcess, startChrome, waitForTargetAbsent } from './chrome-fixture.js';
import { chromeLaunchArgs } from './chrome-launch-args.js';
import { assertNoKilledChromeClone } from './chrome-clone-proof.js';

test('a killed test Chrome leaves no code-sign clone [C7]', async () => {
  await assertNoKilledChromeClone();
});

/** Pause between checks while waiting for a fixture helper's readiness marker. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

/** Wait a finite time for a private marker, reporting only its fixture path on timeout. */
async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await pause(20);
  }
  assert.fail(`stand-in Chrome did not create its readiness marker: ${path}`);
}

/** Create an executable stand-in that writes after its leader exits, keeping both in one process group. */
function delayedHelperScripts(profile) {
  const helperReady = join(profile, 'helper-ready');
  const lateWrite = join(profile, 'helper-finished');
  const helper = [
    "const fs = require('node:fs');",
    'const [ready, late] = process.argv.slice(1);',
    "process.on('SIGTERM', () => { setTimeout(() => { fs.writeFileSync(late, 'finished'); process.exit(0); }, 1500); });",
    "fs.writeFileSync(ready, 'ready');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const leader = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    'const [profile, helperCode] = process.argv.slice(1);',
    "process.on('SIGTERM', () => process.exit(0));",
    "spawn(process.execPath, ['-e', helperCode, profile + '/helper-ready', profile + '/helper-finished'], { stdio: 'ignore' });",
    "fs.writeFileSync(profile + '/leader-ready', 'ready');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  return { helperReady, lateWrite, leader, helper };
}

/** Prove close waits for a surviving process-group helper before a single profile removal. */
test('removes the profile only after every Chrome process exits [C7]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-chrome-group-'));
  const profile = join(directory, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  let removed = false;
  let chrome;
  t.after(async () => {
    try { await chrome?.close(); }
    finally {
      // A deliberately broken close must not leave the stand-in helper alive.
      const pid = chrome?.child.pid;
      if (pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* The owned fixture group is already gone. */ }
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try { process.kill(-pid, 0); } catch (error) { if (error.code === 'ESRCH') break; }
          await pause(20);
        }
      }
    }
    if (!removed) rmSync(profile, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });

  const scripts = delayedHelperScripts(profile);
  chrome = launchChromeProcess({ executable: process.execPath, args: ['-e', scripts.leader, profile, scripts.helper] });
  await waitForFile(scripts.helperReady);
  const closedAt = Date.now();
  await chrome.close();
  assert.ok(Date.now() - closedAt >= 1_300, 'close waited while the helper kept writing after the leader exited'); // budget: declared delayed helper write (1.5 seconds); close must wait for it.
  assert.equal(readFileSync(scripts.lateWrite, 'utf8'), 'finished', 'the helper finished its delayed profile write');
  assert.doesNotThrow(() => rmSync(profile, { recursive: true }), 'one profile removal succeeds after the group is empty');
  removed = true;
});

/** Prove a missing DevTools port is a single diagnostic failure, with stderr and elapsed time. */
test('a missing DevTools port fails once with stderr and elapsed launch time [C7]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-chrome-no-port-'));
  const launches = join(directory, 'launches');
  const wrapper = join(directory, 'chrome-no-port');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CHROME_LAUNCHES, 'launch\\n');",
    "process.stderr.write('NO_PORT_STAND_IN_STDERR\\n');",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  chmodSync(wrapper, 0o700);

  await assert.rejects(startChrome({
    executable: wrapper,
    env: { ...process.env, CHROME_LAUNCHES: launches },
  }), (error) => {
    assert.match(error.message, /did not publish its DevTools port/u);
    assert.match(error.message, /elapsed \d+ms; 30000ms DevTools budget/u);
    assert.ok(Number(/elapsed (\d+)ms/u.exec(error.message)[1]) >= 30_000, 'the stand-in exercised the actual default startup budget'); // budget: declared production DevTools startup deadline is 30000ms.
    assert.match(error.message, /NO_PORT_STAND_IN_STDERR/u);
    return true;
  });
  assert.equal(readFileSync(launches, 'utf8'), 'launch\n', 'the shared launcher never retries');
});

/**
 * Write a stand-in Chrome that stays alive, holds its profile lock and never publishes a DevTools port.
 * A /bin/sh launcher records its start and writes SingletonLock before it execs node to stay alive,
 * so the lock is there within the startup budget even when node itself starts slowly under gate load.
 */
function liveNoPortStandIn(directory) {
  const executable = join(directory, 'chrome-live-no-port');
  writeFileSync(executable, [
    '#!/bin/sh',
    "printf 'start\\n' >> \"$CHROME_STARTS\"",
    "printf 'held' > \"$CHROME_PROFILE/SingletonLock\"",
    "exec \"$CHROME_NODE\" -e \"process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\"",
  ].join('\n') + '\n');
  chmodSync(executable, 0o700);
  return executable;
}

/** Start the live stand-in past its budget and assert the timeout names the leader, port, lock, elapsed time and load. */
async function assertLiveTimeoutNamesState(directory, startupTimeoutMs, extraEnv = {}) {
  const liveProfile = join(directory, 'live-profile');
  const liveMarker = join(directory, 'live-starts');
  const liveExecutable = liveNoPortStandIn(directory);
  await assert.rejects(startChrome({
    executable: liveExecutable,
    profileDirectory: liveProfile,
    startupTimeoutMs,
    env: { ...process.env, ...extraEnv, CHROME_STARTS: liveMarker, CHROME_PROFILE: liveProfile, CHROME_NODE: process.execPath },
  }), (error) => {
    assert.match(error.message, /leader still alive/u);
    assert.match(error.message, /DevToolsActivePort absent/u);
    assert.match(error.message, /profile lock present \(SingletonLock\)/u);
    assert.match(error.message, /elapsed \d+ms; 2000ms DevTools budget/u);
    assert.match(error.message, /load average \[/u);
    const elapsed = Number(/Chrome startup state:.*elapsed (\d+)ms/u.exec(error.message)?.[1]);
    assert.ok(elapsed >= startupTimeoutMs, `the live stand-in reached the startup budget: ${error.message}`); // budget: declared 2000ms startup deadline must actually expire.
    return true;
  });
  assert.equal(readFileSync(liveMarker, 'utf8'), 'start\n', 'the live stand-in launched only once');
}

/** Prove startup timeout diagnostics preserve process and profile state before cleanup [C7]. */
test("a DevTools port timeout names Chrome's state [C7]", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-chrome-timeout-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const startupTimeoutMs = 2_000;
  await assertLiveTimeoutNamesState(directory, startupTimeoutMs);

  const exitedProfile = join(directory, 'exited-profile');
  const exitedMarker = join(directory, 'exited-starts');
  const exitedExecutable = join(directory, 'chrome-exits-no-port');
  // A /bin/sh stand-in exits at once; a node one took past the whole budget to start under gate load (load 9).
  writeFileSync(exitedExecutable, [
    '#!/bin/sh',
    "printf 'start\\n' >> \"$CHROME_STARTS\"",
    'exit 7',
  ].join('\n') + '\n');
  chmodSync(exitedExecutable, 0o700);
  await assert.rejects(startChrome({
    executable: exitedExecutable,
    profileDirectory: exitedProfile,
    startupTimeoutMs,
    env: { ...process.env, CHROME_STARTS: exitedMarker, CHROME_PROFILE: exitedProfile },
  }), (error) => {
    assert.match(error.message, /leader exited \(code 7\)/u);
    assert.match(error.message, /DevToolsActivePort absent/u);
    assert.match(error.message, /profile lock absent/u);
    assert.match(error.message, /elapsed \d+ms; 2000ms DevTools budget/u);
    assert.match(error.message, /load average \[/u);
    return true;
  });
  assert.equal(readFileSync(exitedMarker, 'utf8'), 'start\n', 'the exited stand-in launched only once');
});

/** Prove the timeout still names a live, locked Chrome when node takes longer than the whole budget to start [C7]. */
test('the DevTools timeout test holds when its stand-in starts slowly [C7]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-chrome-slow-start-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const startupTimeoutMs = 2_000;
  // Every node the stand-in runs blocks before its first line, as node did under gate load (measured 2014ms, load 10).
  const slowStart = join(directory, 'slow-node-start.cjs');
  writeFileSync(slowStart, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\n'); // budget: declared start delay past the 2000ms startup deadline.
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(slowStart)}`.trim();
  await assertLiveTimeoutNamesState(directory, startupTimeoutMs, { NODE_OPTIONS: nodeOptions });
});


/** Prove an unrelated process inheriting stderr cannot keep an exited owned Chrome open. */
test('Chrome close releases inherited stderr after its owned process group exits [C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-chrome-inherited-pipe-'));
  const ready = join(directory, 'holder-ready');
  const holder = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
  const leader = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
    child.unref(); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
  const chrome = launchChromeProcess({ executable: process.execPath, args: ['-e', leader, holder, ready] });
  let holderPid;
  t.after(async () => {
    try { await chrome.close(); } catch { /* Retain the original close assertion on a broken implementation. */ }
    if (!holderPid && existsSync(ready)) holderPid = Number(readFileSync(ready, 'utf8'));
    if (holderPid) { try { process.kill(holderPid, 'SIGKILL'); } catch { /* The private stand-in already stopped. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  await waitForFile(ready);
  holderPid = Number(readFileSync(ready, 'utf8'));
  const failure = await chrome.close().then(() => null, error => error);
  assert.equal(failure, null, 'an inherited stderr holder must not prevent owned Chrome cleanup');
  assert.doesNotThrow(() => process.kill(holderPid, 0), 'cleanup closes its pipe without killing an independent process');
  assert.ok(chrome.child.exitCode !== null || chrome.child.signalCode !== null, 'the owned leader exited before close resolved');
});

/** Prove Runtime.evaluate reports page exceptions without changing successful values. */
test('a failed browser evaluation names what the page threw [C7]', async () => {
  const expression = '(() => { throw new Error("boom"); })();\n// ' + 'x'.repeat(240);
  const asyncExpression = '(async () => { throw new TypeError("async boom"); })()';
  const chrome = await startChrome();
  try {
    await assert.rejects(chrome.evaluate(expression), (error) => {
      assert.match(error.message, /Error: boom/u);
      assert.match(error.message, /line 1, column \d+/u);
      assert.ok(error.message.includes('expression: ' + expression.slice(0, 200)), 'diagnostic includes the evaluated expression prefix');
      assert.ok(!error.message.includes(expression.slice(0, 201)), 'diagnostic stops after 200 expression characters');
      assert.notEqual(error.message, 'Browser evaluation failed.');
      return true;
    });
    await assert.rejects(chrome.evaluate(asyncExpression), (error) => {
      assert.match(error.message, /TypeError: async boom/u);
      assert.match(error.message, /line 1, column 22/u);
      assert.ok(error.message.includes('expression: ' + asyncExpression), 'async rejection includes the evaluated expression');
      return true;
    });
    await assert.rejects(chrome.evaluate('throw "a plain string"'), (error) => {
      assert.match(error.message, /^Browser evaluation failed: a plain string \(line /u);
      return true;
    });
    await assert.rejects(chrome.evaluate('throw null'), (error) => {
      assert.match(error.message, /^Browser evaluation failed: null \(line /u);
      return true;
    });
    await assert.rejects(chrome.evaluate('throw ""'), (error) => {
      assert.match(error.message, /^Browser evaluation failed:  \(line /u);
      return true;
    });
    assert.equal(await chrome.evaluate('1 + 1'), 2, 'successful values remain unchanged');
  } finally {
    await chrome.close();
  }
});

/** Prove real CDP failures retain their causes and whether a top-level page navigation occurred [C7]. */
test('a failed DevTools command names its CDP error [C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async () => {
  let afterRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/after') afterRequests += 1;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><body>${request.url === '/after' ? 'after' : 'before'}</body>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let chrome;
  try {
    chrome = await startChrome({ url: `${origin}/before` });
    await chrome.waitFor("location.pathname === '/before' && document.body.textContent === 'before'", 5_000, 'initial document ready'); // budget: hang ceiling for the private initial document handshake; no throughput claim.

    const navigationUrl = `${origin}/after`;
    const navigation = chrome.evaluate(`(() => {
      setTimeout(() => location.assign(${JSON.stringify(navigationUrl)}), 0);
      return new Promise(() => {});
    })()`, 'evaluate during page navigation').then(() => null, (error) => error);
    const navigationError = await navigation;
    assert.ok(navigationError instanceof Error, 'the actual page navigation rejects the pending Runtime.evaluate');
    assert.match(navigationError.message, /Runtime\.evaluate/u);
    assert.match(navigationError.message, /evaluate during page navigation/u);
    assert.match(navigationError.message, /CDP error -\d+: .+/u);
    assert.match(navigationError.message, /Inspected target navigated or closed/u);
    assert.match(navigationError.message, /page navigated since command was sent: yes \(Page\.(?:frameStartedNavigating|frameNavigated)\)/u);
    assert.equal(navigationError.navigated, true, 'the sender attaches its observed main-frame navigation to the error');
    await chrome.waitFor("location.pathname === '/after' && document.body.textContent === 'after'", 5_000, 'replacement document ready'); // budget: hang ceiling for the private replacement document handshake; no throughput claim.
    assert.equal(afterRequests, 1, 'the pending evaluation lost a race with one real HTTP navigation');

    const rejected = await chrome.send('Runtime.noSuchCommand', {}, 'unsupported CDP method').then(() => null, (error) => error);
    assert.ok(rejected instanceof Error, 'Chrome rejects the unsupported protocol method');
    assert.match(rejected.message, /Runtime\.noSuchCommand/u);
    assert.match(rejected.message, /unsupported CDP method/u);
    assert.match(rejected.message, /CDP error -32601: .+/u);
    assert.match(rejected.message, /wasn't found|not found/u);
    assert.match(rejected.message, /page navigated since command was sent: no/u);
    assert.equal(rejected.navigated, false, 'a protocol error without navigation remains distinguishable');
  } finally {
    if (chrome) await chrome.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

/** Prove a confirmed target close rejects a pending command instead of consuming the wait deadline [C7]. */
test('a confirmed target close rejects pending DevTools commands [C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
  timeout: 70_000, // budget: outer hang ceiling for the real Chrome closure scenario; each private wait and fetch also has its own 5s ceiling.
}, async () => {
  const chrome = await startChrome();
  let browserSocket;
  try {
    await chrome.waitFor("document.readyState === 'complete'", 5_000, 'initial document ready'); // budget: hang ceiling for this private close-control handshake.
    const target = await chrome.send('Target.getTargetInfo', {}, 'identify page to close', 5_000); // budget: hang ceiling for the private target-identification handshake.
    const pending = chrome.waitFor('(window.__pendingCloseEntered = true, new Promise(() => {}))', 5_000,
      'wait for a command on the closing target').then(() => ({ error: null }), error => ({ error }));
    await chrome.waitFor('window.__pendingCloseEntered === true', 5_000, 'pending evaluation entered'); // budget: hang ceiling for the private pending-command handshake.

    const version = await fetch(`http://127.0.0.1:${Number(readFileSync(join(chrome.profileDirectory, 'DevToolsActivePort'), 'utf8').split('\n')[0])}/json/version`,
      { signal: AbortSignal.timeout(5_000) }) // budget: hang ceiling for the private browser-control discovery request.
      .then(response => response.json());
    browserSocket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('Chrome browser control socket did not open.')), 5_000); // budget: hang ceiling for the private browser-control handshake.
      browserSocket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      browserSocket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Chrome browser control socket failed.')); }, { once: true });
    });
    const closeResponse = await new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => rejectResponse(new Error('Chrome did not answer the private target-close command.')), 5_000); // budget: hang ceiling for the private browser-control handshake.
      browserSocket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) rejectResponse(new Error(`Chrome refused the private target-close command: ${message.error.message}`));
        else resolveResponse(message.result);
      });
      browserSocket.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: target.targetInfo.targetId } }));
    });
    assert.equal(closeResponse.success, true, 'the independent browser control confirms the actual page target closed');
    await waitForTargetAbsent(remainingMs => fetch(`http://127.0.0.1:${Number(readFileSync(join(chrome.profileDirectory, 'DevToolsActivePort'), 'utf8').split('\n')[0])}/json/list`,
      { signal: AbortSignal.timeout(remainingMs) })
      .then(response => response.json()), target.targetInfo.targetId,
    { timeoutMs: 5_000 }); // budget: one total deadline for confirming target removal from the private browser list.

    const outcome = await pending;
    assert.ok(outcome.error instanceof Error, 'the pending Runtime.evaluate rejects when its target closes');
    assert.equal(outcome.error.code, 'CDP_TARGET_CLOSED', 'target closure has a distinct non-navigation error code');
    assert.equal(outcome.error.navigated, false, 'target closure is not mislabeled as main-frame navigation');
    assert.match(outcome.error.message, /Runtime\.evaluate "wait for a command on the closing target"/u,
      'the actual pending operation remains named in the closure error');
    assert.match(outcome.error.message, /target detached|socket closed|socket failed/u,
      'the pending command receives the actual transport or Inspector closure signal');
    await assert.rejects(chrome.send('Runtime.evaluate', { expression: 'true' }, 'send after target close'), error => {
      assert.equal(error.code, 'CDP_TARGET_CLOSED', 'a closed target refuses later commands with the same terminal code');
      assert.match(error.message, /send after target close/u, 'the refused later command remains named');
      return true;
    });
  } finally {
    browserSocket?.close();
    await chrome.close();
  }
});

/** Exercise the actual target-removal waiter with one stale list and a controlled deadline. */
test('a closed target that is still listed once is not reported as open [C7]', async () => {
  let clock = 0;
  let reads = 0;
  const budgets = [];
  const options = { timeoutMs: 100, now: () => clock, pauseFor: async ms => { clock += ms; } };
  const error = await waitForTargetAbsent(async remainingMs => {
    budgets.push(remainingMs);
    reads += 1;
    return reads === 1 ? [{ id: 'closed-target' }] : [{ id: 'other-target' }];
  }, 'closed-target', options).then(() => null, failure => failure);
  assert.equal(error, null, 'a first stale target list must be followed by confirmation of removal');
  assert.equal(reads, 2, 'the waiter reads Chrome again before confirming removal');
  assert.deepEqual(budgets, [100, 50], 'each list request receives only the remaining operation budget');

  clock = 0;
  reads = 0;
  await assert.rejects(waitForTargetAbsent(async () => {
    reads += 1;
    return [{ id: 'closed-target' }];
  }, 'closed-target', options), /Closed DevTools target closed-target remained listed within 100ms/u);
  assert.equal(reads, 2, 'a target that stays listed cannot silently pass or poll beyond its declared deadline');
});

/** Prove a page condition cannot spend the much longer general command allowance. */
test('a stalled condition uses its remaining operation budget [C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const budgetMs = 250;
  const scheduler = monitorEventLoopDelay({ resolution: 10 });
  scheduler.enable();
  const startedAt = Date.now();
  let failure;
  try { await chrome.waitFor('new Promise(() => {})', budgetMs, 'bounded condition'); } // budget: declared 250ms operation deadline for a deliberately unresolved page condition.
  catch (error) { failure = error; }
  const elapsedMs = Date.now() - startedAt;
  scheduler.disable();
  const schedulerSlackMs = Math.ceil(scheduler.max / 1e6);
  const details = `budget=${budgetMs}ms elapsed=${Math.round(elapsedMs)}ms schedulerSlack=${schedulerSlackMs}ms loadavg=${JSON.stringify(loadavg())}`;
  const conditionTimeout = failure instanceof Error
    && /Browser condition "bounded condition" did not arrive within 250ms/u.test(failure.message);
  assert.ok(conditionTimeout,
    `the stalled page condition should time out at its operation budget; ${details}; failure=${failure?.message ?? 'none'}`);
  assert.ok(elapsedMs <= budgetMs + schedulerSlackMs,
    `the 250ms condition stayed within its measured budget plus scheduler delay; ${details}`);
  assert.equal(await chrome.evaluate('1 + 1'), 2, 'timing out one command leaves the real DevTools connection usable');
});

test('a DevTools timer that fires early still times out at its budget [C7]', async () => {
  let now = 10_000;
  const scheduled = [];
  const timers = {
    /** Read the simulated clock used by both timer arming and diagnostics. */
    now() { return now; },
    /** Capture each timer so the test can fire the first one exactly 1ms early. */
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    /** Mark cancellation without advancing simulated time. */
    clearTimeout(timer) {
      timer.cleared = true;
    },
  };
  const socket = { addEventListener() {}, send() {} };
  const pending = new Map();
  const send = createSender(socket, pending, () => 1, 250, { max: 0 }, new Set(), timers);
  const result = send('Runtime.evaluate', {}, 'early timer').catch(error => error);
  assert.equal(scheduled[0].delay, 250, 'the first timer receives the full command budget'); // budget: declared 250ms command allowance on a simulated clock, not machine speed.

  now += 249;
  scheduled.shift().callback();
  assert.equal(scheduled.length, 1, 'a timer firing 1ms early is re-armed');
  assert.equal(scheduled[0].delay, 1, 'the re-armed timer uses only the remaining budget'); // budget: declared simulated clock advanced 249ms of its 250ms allowance.

  now += 1;
  scheduled.shift().callback();
  const error = await result;
  assert.equal(error.code, 'CDP_TIMEOUT');
  assert.match(error.message, /timed out after 250ms/u, 'the reported duration reaches its budget');
  assert.equal(pending.size, 0, 'the timed-out command is removed from the pending set');
});

test('a wait that throws while the page changes keeps waiting [C7]', async (t) => {
  let replacementResponse;
  const transition = {
    replacementStartedAt: null,
    firstRendererSampleAt: null,
    firstRendererSampleHadBody: null,
    rendererSampleStatus: 'not-reported',
    gapSampledAt: null,
    gapAcknowledgedAt: null,
    responseFinishedAt: null,
    firstRaceBranch: null,
    waitError: null,
    cpuThrottleRate: null,
  };
  const server = createServer((request, response) => {
    if (request.url === '/before') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><body><script>window.goNext = () => location.replace("/next")</script>before</body>');
      return;
    }
    if (request.url === '/next') {
      response.writeHead(200, { 'content-type': 'text/html' });
      transition.replacementStartedAt = Date.now();
      response.write('<!doctype html><html><head><title>loading');
      replacementResponse = response;
      return;
    }
    if (request.url.startsWith('/observed-null?')) {
      response.writeHead(204);
      response.end();
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      transition.firstRendererSampleAt = Number(query.get('sampledAt'));
      transition.firstRendererSampleHadBody = query.get('body') === 'true';
      transition.rendererSampleStatus = 'server-received-gap-sample';
      transition.gapSampledAt = transition.firstRendererSampleAt;
      transition.gapAcknowledgedAt = Date.now();
      server.emit('document-gap-observed');
      replacementResponse?.end('</title></head><body>ready</body></html>', () => {
        transition.responseFinishedAt = Date.now();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const documentGapObserved = new Promise((resolveGap) => server.once('document-gap-observed', resolveGap));
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) server.close();
  });

  const chrome = await startChrome({ url: `http://127.0.0.1:${server.address().port}/before` });
  try {
    await chrome.waitFor("typeof window.goNext === 'function'", 5_000, 'initial document ready'); // budget: hang ceiling for the private navigation control handshake; no throughput claim.
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    transition.cpuThrottleRate = 6;
    await chrome.evaluate('setTimeout(() => window.goNext(), 0); true');
    const expression = "location.pathname === '/next' ? (() => { if (!window.__raceSampled) { window.__raceSampled = true; window.__raceSampledAt = Date.now(); window.__raceSampledHadBody = Boolean(document.body); if (!window.__raceSampledHadBody) fetch('/observed-null?sampledAt=' + window.__raceSampledAt + '&body=false'); } return document.body.textContent.includes('ready'); })() : false";
    const waiting = chrome.waitFor(expression, 5_000, 'wait for the replacement document')
      .then(() => ({ error: null }), (error) => ({ error }));
    const first = await Promise.race([
      documentGapObserved.then(() => ({ branch: 'gap-observed' })),
      waiting.then((result) => ({ branch: result.error ? 'wait-rejected' : 'wait-resolved', result })),
    ]);
    transition.firstRaceBranch = first.branch;
    if (first.result?.error) transition.waitError = {
      name: first.result.error.name,
      code: first.result.error.code ?? null,
      message: first.result.error.message,
    };
    if (first.branch === 'wait-rejected') transition.rendererSampleStatus = 'unavailable-after-wait-rejection';
    if (first.branch === 'gap-observed') {
      const waitResult = await waiting;
      transition.waitError = waitResult.error ? {
        name: waitResult.error.name,
        code: waitResult.error.code ?? null,
        message: waitResult.error.message,
      } : null;
    } else if (first.branch === 'wait-resolved') {
      const sample = await chrome.evaluate('({ sampledAt: window.__raceSampledAt ?? null, bodyPresent: window.__raceSampledHadBody ?? null })');
      transition.firstRendererSampleAt = sample.sampledAt;
      transition.firstRendererSampleHadBody = sample.bodyPresent;
      transition.rendererSampleStatus = 'browser-readback-after-wait-resolution';
    }
    const evidence = JSON.stringify(transition);
    t.diagnostic(`6× wait transition capture: ${evidence}`);
    assert.equal(first.branch, 'gap-observed', `the wait samples the no-body gap before resolving; transition=${evidence}`);
    assert.equal(transition.rendererSampleStatus, 'server-received-gap-sample', `the server records the renderer gap sample; transition=${evidence}`);
    assert.equal(transition.firstRendererSampleHadBody, false, `the renderer sampled the replacement before its body; transition=${evidence}`);
    assert.ok(Number.isFinite(transition.firstRendererSampleAt) && Number.isFinite(transition.gapAcknowledgedAt), `the sample and server acknowledgement were both recorded; transition=${evidence}`);
    assert.ok(transition.gapSampledAt <= transition.gapAcknowledgedAt, `the server acknowledgement follows the renderer sample; transition=${evidence}`);
    assert.ok(Number.isFinite(transition.responseFinishedAt), `the server records replacement response completion; transition=${evidence}`);
    assert.ok(transition.gapAcknowledgedAt <= transition.responseFinishedAt, `the held response finishes after the server acknowledges the gap; transition=${evidence}`);
    assert.equal(transition.waitError, null, `the document-transition exception stays pending until the next page is ready; transition=${evidence}`);
    assert.equal(await chrome.evaluate('document.body.textContent'), 'ready', 'the replacement document completed');

    const alwaysThrows = '(() => { throw new Error("persistent evaluation failure"); })()';
    const startedAt = Date.now();
    await assert.rejects(chrome.waitFor(alwaysThrows, 350, 'always-throwing expression'), (error) => { // budget: declared 350ms operation deadline for an always-throwing condition.
      assert.match(error.message, /did not arrive within 350ms/u);
      assert.match(error.message, /persistent evaluation failure/u);
      assert.ok(error.message.includes(alwaysThrows), 'deadline diagnostic names the expression');
      assert.ok(Date.now() - startedAt >= 350, 'the wait polls through its requested deadline'); // budget: declared 350ms operation deadline must actually expire.
      return true;
    });

  } catch (error) {
    transition.waitError ??= { name: error.name, code: error.code ?? null, message: error.message };
    t.diagnostic(`transition capture before test failure: ${JSON.stringify(transition)}`);
    throw error;
  } finally {
    await chrome.close();
  }
});

/** Prove waitFor retries a DevTools navigation error instead of abandoning its condition. */
test('a wait keeps waiting through a DevTools error from a page navigation [C7]', async (t) => {
  let afterRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/before') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><body>before</body>');
      return;
    }
    if (request.url === '/after') {
      afterRequests += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><body>after</body>');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) server.close();
  });

  const chrome = await startChrome({ url: `${origin}/before` });
  try {
    await chrome.waitFor("location.pathname === '/before' && document.body.textContent === 'before'", 5_000, 'initial document ready'); // budget: hang ceiling for the private initial document handshake; no throughput claim.
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const expression = `location.pathname === '/before' ? (() => {
      if (!window.__navigationScheduled) {
        window.__navigationScheduled = true;
        setTimeout(() => location.assign('/after'), 0);
      }
      return new Promise(() => {});
    })() : location.pathname === '/after' && document.body.textContent === 'after'`;
    const waitResult = await chrome.waitFor(expression, 5_000, 'wait across document navigation' /* budget: declared 5000ms deadline for this local document-transition condition. */)
      .then(() => ({ resolved: true }), error => ({ resolved: false, error })); // budget: declared 5s ceiling for the local replacement-document handshake.
    assert.equal(waitResult.resolved, true, // budget: this asserts the declared navigation-condition deadline's outcome, not elapsed throughput.
      `the wait retries a DevTools failure from a main-frame navigation; failure=${waitResult.error?.message ?? 'none'}`);
    assert.equal(await chrome.evaluate('document.body.textContent'), 'after', 'the wait resolves on the replacement document');
    assert.equal(afterRequests, 1, 'the real navigation occurs once');

    await chrome.send('Page.navigate', { url: `${origin}/before` }, 'return to the initial document');
    await chrome.waitFor("location.pathname === '/before' && document.body.textContent === 'before'", 5_000, 'initial document ready again'); // budget: hang ceiling for the private reset handshake; no throughput claim.
    const exhaustedExpression = `location.pathname === '/before' ? (() => {
      if (!window.__navigationScheduled) {
        window.__navigationScheduled = true;
        setTimeout(() => location.assign('/after'), 0);
      }
      return new Promise(() => {});
    })() : false`;
    const exhausted = await chrome.waitFor(exhaustedExpression, 5_000, 'wait expires after a navigation error' /* budget: declared 5000ms deadline for a deliberately pending local page condition. */)
      .then(() => ({ resolved: true }), error => ({ resolved: false, error })); // budget: declared 5s private observation ceiling for a local page condition that remains false.
    assert.equal(exhausted.resolved, false, 'the condition remains pending until its declared deadline'); // budget: checks the declared operation-deadline outcome, not elapsed throughput.
    assert.match(exhausted.error.message, /did not arrive within 5000ms/u); // budget: exact diagnostic for the declared 5000ms operation deadline.
    assert.match(exhausted.error.message, /last evaluation failed: DevTools command failed: Runtime\.evaluate/u, // budget: checks retained diagnostics at the declared deadline, not elapsed throughput.
      'the exhausted wait names its last navigation error');
    assert.match(exhausted.error.message, /CDP error -32000/u); // budget: preserves the CDP error captured before the declared deadline.
    assert.match(exhausted.error.message, /page navigated since command was sent: yes/u); // budget: preserves navigation evidence at the declared deadline.
    assert.equal(afterRequests, 2, 'the exhausted wait observes a second real navigation');

    let receiveMessage;
    let commandCount = 0;
    const fakeSocket = {
      addEventListener(type, listener) {
        if (type === 'message') receiveMessage = listener;
      },
      send(frame) {
        const { id } = JSON.parse(frame);
        commandCount += 1;
        queueMicrotask(() => receiveMessage({ data: JSON.stringify(commandCount === 1
          ? { id, error: { code: -32000, message: 'Target closed' } }
          : { id, result: { result: { value: true } } }) }));
      },
    };
    const protocolSend = createSender(fakeSocket, new Map(), () => 1, 15_000, { max: 0 }, new Set());
    const protocolEvaluate = createEvaluator(protocolSend);
    const protocolWait = createWaiter(protocolEvaluate, { commandTimeoutMs: 5_000 });
    const noNavigation = await protocolWait('true', 5_000, 'no-navigation protocol error' /* budget: declared 5000ms protocol-operation ceiling; fixture reply is immediate. */)
      .then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    assert.equal(noNavigation.rejected, true, 'a no-navigation protocol error is rethrown immediately'); // budget: checks the immediate result against the declared command ceiling.
    assert.equal(noNavigation.error.code, -32000, 'the original CDP code is preserved'); // budget: verifies the error returned within the declared command ceiling.
    assert.equal(noNavigation.error.navigated, false, 'the sender observed no main-frame navigation'); // budget: verifies the error returned within the declared command ceiling.
    assert.match(noNavigation.error.message, /page navigated since command was sent: no/u); // budget: verifies preserved protocol diagnostics within the declared command ceiling.
    assert.equal(commandCount, 1, 'the wait does not retry a no-navigation CDP error');

    let clock = 0;
    let evaluations = 0;
    let pauses = 0;
    let firstError;
    const deadlineWait = createWaiter(async () => {
      evaluations += 1;
      if (evaluations === 1) {
        firstError = Object.assign(new Error('DevTools command failed: Runtime.evaluate; CDP error -32000; page navigated since command was sent: yes'), {
          code: -32000,
          navigated: true,
        });
        throw firstError;
      }
      return false;
    }, {
      commandTimeoutMs: 5_000,
      now: () => clock,
      pauseFor: async ms => {
        pauses += 1;
        assert.ok(pauses <= 100, 'the injected clock advances within the declared deadline');
        clock += ms;
      },
    });
    await assert.rejects(deadlineWait('false', 5_000, 'simulated navigation deadline'), error => { // budget: declared 5000ms simulated operation deadline, advanced deterministically; no wall-clock judgment.
      assert.match(error.message, /did not arrive within 5000ms/u);
      assert.match(error.message, /last evaluation failed: DevTools command failed: Runtime\.evaluate/u);
      assert.match(error.message, /CDP error -32000/u);
      assert.match(error.message, /page navigated since command was sent: yes/u);
      return true;
    });
    assert.equal(clock, 5_000, 'the injected clock reaches the operation deadline exactly');
    assert.equal(evaluations, 100, 'the wait polls only while time remains');
    assert.equal(pauses, 100, 'each poll advances the injected clock by its bounded interval');
    assert.ok(firstError instanceof Error, 'the simulated first navigation error is retained');
  } finally {
    await chrome.close();
  }
});

test('fixture close quits actual Chrome cleanly before any signal fallback [C7]', { timeout: 40000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-clone-graceful-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  const launched = launchChromeProcess({ executable: findChromeExecutable(), args: chromeLaunchArgs(profile) });
  t.after(() => launched.close());
  const deadline = Date.now() + 30000;
  while (!existsSync(join(profile, 'DevToolsActivePort')) && Date.now() < deadline) {
    assert.equal(launched.child.exitCode, null, launched.stderr);
    assert.equal(launched.child.signalCode, null, launched.stderr);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(join(profile, 'DevToolsActivePort')), launched.stderr);
  await launched.close();
  assert.equal(launched.child.exitCode, 0, 'Browser.close must produce a clean native exit');
  assert.equal(launched.child.signalCode, null, 'a signal fallback is not graceful proof');
});
