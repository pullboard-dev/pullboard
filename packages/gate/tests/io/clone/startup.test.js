// pullboard: browser
/** @pullboard-test-gui */
/** The shared Chrome fixture bounds startup and names Chrome's state when its DevTools port never arrives [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startChrome } from '../../fixtures/chrome.js';

/** Prove a missing DevTools port is a single diagnostic failure, with stderr and elapsed time. */
test('gate.io-clone-startup.a-missing-devtools-port-fails-once: a missing DevTools port fails once with stderr and elapsed launch time [C7]', async (t) => {
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

  // The 30000ms production default is proven on a real launch in devtools.test.js; waiting it out here set the proof floor (#5811).
  const startupTimeoutMs = 2_000;
  await assert.rejects(startChrome({
    executable: wrapper,
    startupTimeoutMs,
    env: { ...process.env, CHROME_LAUNCHES: launches },
  }), (error) => {
    assert.match(error.message, /did not publish its DevTools port/u);
    assert.match(error.message, /elapsed \d+ms; 2000ms DevTools budget/u);
    assert.ok(Number(/elapsed (\d+)ms/u.exec(error.message)[1]) >= startupTimeoutMs, 'the stand-in exercised the whole startup budget'); // budget: declared 2000ms DevTools startup deadline must actually expire.
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
test('gate.io-clone-startup.a-devtools-port-timeout-names-chrome: a DevTools port timeout names Chrome\'s state [C7]', async (t) => {
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
test('gate.io-clone-startup.the-devtools-timeout-test-holds-when: the DevTools timeout test holds when its stand-in starts slowly [C7]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-chrome-slow-start-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const startupTimeoutMs = 2_000;
  // Every node the stand-in runs blocks before its first line, as node did under gate load (measured 2014ms, load 10).
  const slowStart = join(directory, 'slow-node-start.cjs');
  writeFileSync(slowStart, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\n'); // budget: declared start delay past the 2000ms startup deadline.
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(slowStart)}`.trim();
  await assertLiveTimeoutNamesState(directory, startupTimeoutMs, { NODE_OPTIONS: nodeOptions });
});
