// pullboard: browser
/** @pullboard-test-gui */
/** The shared Chrome fixture removes profiles only after the owned process group exits, and closes real Chrome cleanly [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findChromeExecutable } from '../../../../apps/cli/tests/fixtures/chrome.js';
import { launchChromeProcess } from '../../../../apps/cli/tests/fixtures/chrome.js';
import { chromeLaunchArgs } from '../../../../apps/cli/tests/fixtures/chrome/args.js';
import { assertNoKilledChromeClone } from '../fixtures/clone.js';

test('a killed test Chrome leaves no code-sign clone [C7]', async () => {
  await assertNoKilledChromeClone({ launchChromeProcess, chromeLaunchArgs });
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
