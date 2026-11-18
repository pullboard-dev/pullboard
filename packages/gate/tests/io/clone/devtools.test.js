// pullboard: browser
/** @pullboard-test-gui */
/** The raw DevTools client names page exceptions, CDP errors and closed targets, and keeps each command within its budget [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { test } from 'node:test';
import { createSender } from '../../../../../apps/cli/tests/fixtures/chrome.js';
import { findChromeExecutable } from '../../../../../apps/cli/tests/fixtures/chrome.js';
import { startChrome } from '../../../../../apps/cli/tests/fixtures/chrome.js';
import { waitForTargetAbsent } from '../../../../../apps/cli/tests/fixtures/chrome.js';

/** Prove Runtime.evaluate reports page exceptions without changing successful values. */
test('gate.io-clone-devtools.a-failed-browser-evaluation-names-what: a failed browser evaluation names what the page threw [C7]', async () => {
  const expression = '(() => { throw new Error("boom"); })();\n// ' + 'x'.repeat(240);
  const asyncExpression = '(async () => { throw new TypeError("async boom"); })()';
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = function capture(chunk, ...rest) { written.push(String(chunk)); return write.call(this, chunk, ...rest); };
  let chrome;
  try { chrome = await startChrome(); } finally { process.stderr.write = write; }
  try {
    // A launch with no budget option runs under the production default; startup.test.js proves a missing port waits out the whole budget.
    assert.match(written.join(''), /Chrome ready in \d+ms \(30000ms DevTools budget\)/u, 'startChrome defaults to the 30000ms production DevTools budget');
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
test('gate.io-clone-devtools.a-failed-devtools-command-names-its: a failed DevTools command names its CDP error [C7]', {
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
test('gate.io-clone-devtools.a-confirmed-target-close-rejects-pending: a confirmed target close rejects pending DevTools commands [C7]', {
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
test('gate.io-clone-devtools.a-closed-target-that-is-still: a closed target that is still listed once is not reported as open [C7]', async () => {
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
test('gate.io-clone-devtools.a-stalled-condition-uses-its-remaining: a stalled condition uses its remaining operation budget [C7]', {
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

test('gate.io-clone-devtools.a-devtools-timer-that-fires-early: a DevTools timer that fires early still times out at its budget [C7]', async () => {
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
