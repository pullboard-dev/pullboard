/** The shared Chrome fixture bounds startup and removes profiles only after the owned process group exits [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { test } from 'node:test';
import { findChromeExecutable, isRoundedBudgetBoundary, launchChromeProcess, startChrome } from './chrome-fixture.js';

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
  assert.ok(Date.now() - closedAt >= 1_300, 'close waited while the helper kept writing after the leader exited');
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
    assert.ok(Number(/elapsed (\d+)ms/u.exec(error.message)[1]) >= 30_000, 'the stand-in exercised the actual default startup budget');
    assert.match(error.message, /NO_PORT_STAND_IN_STDERR/u);
    return true;
  });
  assert.equal(readFileSync(launches, 'utf8'), 'launch\n', 'the shared launcher never retries');
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
  try { await chrome.waitFor('new Promise(() => {})', budgetMs, 'bounded condition'); }
  catch (error) { failure = error; }
  const elapsedMs = Date.now() - startedAt;
  scheduler.disable();
  const schedulerSlackMs = Math.ceil(scheduler.max / 1e6);
  const details = `budget=${budgetMs}ms elapsed=${Math.round(elapsedMs)}ms schedulerSlack=${schedulerSlackMs}ms loadavg=${JSON.stringify(loadavg())}`;
  const cdpTimeout = failure instanceof Error
    && /DevTools Runtime\.evaluate "bounded condition" timed out after (\d+)ms/u.exec(failure.message);
  const conditionTimeout = failure instanceof Error
    && /Browser condition "bounded condition" did not arrive within 250ms/u.test(failure.message);
  assert.ok(conditionTimeout || (cdpTimeout && isRoundedBudgetBoundary(Number(cdpTimeout[1]), elapsedMs, budgetMs)),
    `the stalled page condition should time out at its operation budget; ${details}; failure=${failure?.message ?? 'none'}`);
  assert.ok(elapsedMs <= budgetMs + schedulerSlackMs,
    `the 250ms condition stayed within its measured budget plus scheduler delay; ${details}`);
  assert.equal(await chrome.evaluate('1 + 1'), 2, 'timing out one command leaves the real DevTools connection usable');
});

test('a timeout at the budget boundary passes [C7]', () => {
  assert.equal(isRoundedBudgetBoundary(249, 250, 250), true,
    'a 249ms CDP report rounded to 250ms by the shared wall clock is at the budget boundary');
  assert.equal(isRoundedBudgetBoundary(248, 250, 250), false,
    'a two-millisecond early CDP timeout is outside the rounding boundary');
  assert.equal(isRoundedBudgetBoundary(249, 251, 250), false,
    'elapsed time beyond the budget is not accepted as a rounding boundary');
});

test('a wait that throws while the page changes keeps waiting [C7]', async (t) => {
  let replacementResponse;
  const server = createServer((request, response) => {
    if (request.url === '/before') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><body><script>window.goNext = () => location.replace("/next")</script>before</body>');
      return;
    }
    if (request.url === '/next') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<!doctype html><html><head><title>loading');
      replacementResponse = response;
      return;
    }
    if (request.url === '/observed-null') {
      response.writeHead(204);
      response.end();
      server.emit('document-gap-observed');
      replacementResponse?.end('</title></head><body>ready</body></html>');
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
    await chrome.waitFor("typeof window.goNext === 'function'", 5_000, 'initial document ready');
    await chrome.evaluate('setTimeout(() => window.goNext(), 0); true');
    const expression = "location.pathname === '/next' && document.body === null ? (() => { if (!window.__gapNotified) { window.__gapNotified = true; fetch('/observed-null'); } return document.body.textContent.includes('ready'); })() : document.body?.textContent.includes('ready') === true";
    const waiting = chrome.waitFor(expression, 5_000, 'wait for the replacement document')
      .then(() => ({ error: null }), (error) => ({ error }));
    const first = await Promise.race([
      documentGapObserved.then(() => ({ gapObserved: true })),
      waiting.then((result) => ({ result })),
    ]);
    assert.equal(first.gapObserved, true, 'the real page expression observed its document without a body');
    const waitResult = await waiting;
    assert.equal(waitResult.error, null, 'the document-transition exception stays pending until the next page is ready');
    assert.equal(await chrome.evaluate('document.body.textContent'), 'ready', 'the replacement document completed');

    const alwaysThrows = '(() => { throw new Error("persistent evaluation failure"); })()';
    const startedAt = Date.now();
    await assert.rejects(chrome.waitFor(alwaysThrows, 350, 'always-throwing expression'), (error) => {
      assert.match(error.message, /did not arrive within 350ms/u);
      assert.match(error.message, /persistent evaluation failure/u);
      assert.ok(error.message.includes(alwaysThrows), 'deadline diagnostic names the expression');
      assert.ok(Date.now() - startedAt >= 350, 'the wait polls through its requested deadline');
      return true;
    });

  } finally {
    await chrome.close();
  }
});
