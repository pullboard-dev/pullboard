/** The shared Chrome fixture bounds startup and removes profiles only after the owned process group exits [C7]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findChromeExecutable, launchChromeProcess, startChrome } from './chrome-fixture.js';

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
  const started = Date.now();
  await assert.rejects(chrome.waitFor('new Promise(() => {})', 250, 'bounded condition'),
    /Browser condition "bounded condition" did not arrive within 250ms/u);
  assert.ok(Date.now() - started < 10_000, 'the 250ms operation never consumes the 15000ms command allowance');
  assert.equal(await chrome.evaluate('1 + 1'), 2, 'timing out one command leaves the real DevTools connection usable');
});
