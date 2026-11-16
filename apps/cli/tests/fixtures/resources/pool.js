/** Shared private-pool fixture for the machine resource queue tests: isolated machine homes, real worker processes and their cleanup [Q1,Q2,Q3]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../child.js';
import { runFixtureChild as spawnSync } from '../child.js';
import { reportFixtureChildFailure } from '../child.js';
import { runFixtureChild } from '../child.js';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { listResources } from '../../../../../packages/resources/index.js';
import { takeResource } from '../../../../../packages/resources/index.js';
import { resourceWorkerSources } from './lease.js';

const TEMP = [];
const CHILDREN = new Set();
const MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/resources/index.js')).href;
const GATE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
const PRE_RUNNER_MODULE = pathToFileURL(resolve(import.meta.dirname, '../runners.js')).href;
const SETTINGS_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/config/src/io/settings.js')).href;
const TEST_RUNNER = resolve(import.meta.dirname, '../../../../../apps/cli/src/io/run/tests.js');
const PROCESS_INFO_POLICY = '(version 1)(allow default)(deny process-info*)';
const SANDBOX_EXEC = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PERL_FORK = process.platform === 'darwin' && existsSync('/usr/bin/perl');
const { POOL_MODULE_WORKER, SUBMIT_CHECK, WORKER, MEMORY_WORKER } = resourceWorkerSources({ resourcesModule: MODULE, gateModule: GATE_MODULE, settingsModule: SETTINGS_MODULE });

/** Create isolated machine storage and a pair of real Git repositories. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-resources-'));
  TEMP.push(dir);
  const home = join(dir, 'home');
  const first = join(dir, 'repo-a');
  const second = join(dir, 'repo-b');
  for (const repo of [first, second]) {
    mkdirSync(repo);
    const result = runFixtureChild('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure);
  }
  return { dir, home, first, second, env: { ...process.env, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home } };
}

/** Wait for a fixture command to create a marker file, with a hang ceiling only for failure. */
function waitForMarker(path, timeoutMs = 60_000) {
  if (existsSync(path)) return Promise.resolve();
  const watcher = watch(realpathSync(dirname(path)), { persistent: false });
  return new Promise((resolveMarker, rejectMarker) => {
    let settled = false;
    let timer;
    let poller;
    /** Release the deadline, fallback poller, and watcher together. */
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poller);
      watcher.close();
    };
    /** Settle the marker promise once and always release its observers. */
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? rejectMarker(error) : resolveMarker();
    };
    /** Check for the marker after a watch event or bounded poll interval. */
    const check = () => {
      if (!existsSync(path)) return;
      finish();
    };
    timer = setTimeout(() => finish(existsSync(path) ? null : new Error(`timed out waiting for ${path}`)), timeoutMs);
    poller = setInterval(check, 100);
    watcher.on('error', finish);
    watcher.on('change', check);
    watcher.on('rename', check);
    check();
  });
}

/** Read a private machine database without changing the process environment for other fixtures. */
function privateList(box, scope = 'machine', root = process.cwd()) {
  const previous = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  try { return listResources({ scope, root }); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previous;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
}

/** Open a real fixture pool before restoring the parent's unrelated machine-home environment. */
function privateTake(box, options) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  try { return takeResource({ ...options, root: box.first }); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/** Launch one independent process that takes a resource and waits for a release command. */
function worker(box, { name = 'gate', capacity = 1, scope = 'machine', root = box.first, agent, stallMs = 0, landing = false, env = {}, sandboxProcessInfo = false }) {
  const workerArgs = ['--input-type=module', '-e', WORKER, name, String(capacity), scope, root, agent, String(stallMs), String(landing)];
  const executable = sandboxProcessInfo ? '/usr/bin/sandbox-exec' : process.execPath;
  const args = sandboxProcessInfo ? ['-p', PROCESS_INFO_POLICY, process.execPath, ...workerArgs] : workerArgs;
  const startedAt = performance.now();
  const workerEnv = { ...box.env, ...env };
  const child = spawn(executable, args, {
    env: workerEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.startedAt = startedAt;
  child.spawnEnv = workerEnv;
  child.lines = createInterface({ input: child.stdout });
  child.errors = '';
  child.pendingLines = [];
  child.lineWaiters = [];
  child.exitResult = null;
  child.failureReported = false;
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  child.finished = new Promise((resolveExit) => child.once('close', (code, signal) => {
    child.exitResult = { code, signal };
    CHILDREN.delete(child);
    if ((code !== 0 || signal || spawnError) && !child.failureReported) {
      child.failureReported = true;
      child.failure = reportFixtureChildFailure({ command: executable, args, status: code, signal,
        elapsedMs: performance.now() - startedAt, stderr: child.errors, env: workerEnv,
        detail: spawnError?.message ?? '' });
    }
    for (const waiter of child.lineWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(child.failure ?? `worker exited ${code}/${signal}: ${child.errors}`));
    }
    resolveExit(child.exitResult);
  }));
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.errors += chunk; });
  child.lines.on('line', (line) => {
    const waiter = child.lineWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); }
    else child.pendingLines.push(line);
  });
  CHILDREN.add(child);
  return child;
}

/** Launch a dedicated gate-pool worker carrying browser and queue-priority metadata, or another pool script. */
function poolWorker(box, { agent, browser = false, item = '', kind = '', landing = false, module = MODULE, script = POOL_MODULE_WORKER, args }) {
  // module swaps in another resources implementation, such as an older pullboard's, for mixed-version tests.
  const workerArgs = ['--input-type=module', '-e', script.replace(JSON.stringify(MODULE), JSON.stringify(module)), ...(args ?? [box.first, agent, String(browser), item, kind, String(landing)])];
  const startedAt = performance.now();
  const child = spawn(process.execPath, workerArgs, {
    env: box.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.startedAt = startedAt;
  child.spawnEnv = box.env;
  child.lines = createInterface({ input: child.stdout });
  child.errors = '';
  child.pendingLines = [];
  child.lineWaiters = [];
  child.exitResult = null;
  child.failureReported = false;
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  child.finished = new Promise((resolveExit) => child.once('close', (code, signal) => {
    child.exitResult = { code, signal };
    CHILDREN.delete(child);
    if ((code !== 0 || signal || spawnError) && !child.failureReported) {
      child.failureReported = true;
      child.failure = reportFixtureChildFailure({ command: process.execPath, args: workerArgs, status: code, signal,
        elapsedMs: performance.now() - startedAt, stderr: child.errors, env: box.env,
        detail: spawnError?.message ?? '' });
    }
    for (const waiter of child.lineWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(child.failure ?? `pool worker exited ${code}/${signal}: ${child.errors}`));
    }
    resolveExit(child.exitResult);
  }));
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.errors += chunk; });
  child.lines.on('line', (line) => {
    const waiter = child.lineWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); }
    else child.pendingLines.push(line);
  });
  CHILDREN.add(child);
  return child;
}

/** Set or remove the opt-in browser-free-check policy in a fixture's machine settings. */
function setBrowserFreeChecks(box, value) {
  const file = join(box.home, 'settings.json');
  if (value === undefined) { rmSync(file, { force: true }); return; }
  mkdirSync(box.home, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ gate: { browserFreeChecks: value } }, null, 2)}\n`);
}

/** Write a fixture's machine queue-order settings (gate.queue); undefined removes the settings file. */
function setQueueOrder(box, queue) {
  const file = join(box.home, 'settings.json');
  if (queue === undefined) { rmSync(file, { force: true }); return; }
  mkdirSync(box.home, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ gate: { queue } }, null, 2)}\n`);
}

/**
 * Requeue a remote run whose runner dropped, and report the line and real admission order.
 * Two local slots are held; a focused run, then a submit, then a review wait for them; a
 * remote-capable focused run takes the only free runner, which then drops, so its ticket returns
 * to the pool. Shared by the class-order test (#651) and the settings test (#697).
 *
 * @param {object|undefined} queue - The fixture's gate.queue settings, or undefined for none.
 * @returns {Promise<{ order: string|undefined, line: Array<[string, string]>, admitted: string[], tickets: Record<string, number>, lastIssued: number }>}
 */
async function requeuedRemoteRun(queue) {
  const box = fixture();
  setQueueOrder(box, queue);
  const localHolders = [poolWorker(box, { agent: 'local-one' }), poolWorker(box, { agent: 'local-two' })];
  for (const holder of localHolders) await acquired(holder);
  const waiting = new Map();
  for (const [agent, options] of [['focused-early', { kind: 'focused' }], ['submit-later', { kind: 'submit', item: '650' }], ['review-later', { kind: 'review', item: '651' }]]) {
    const child = poolWorker(box, { agent, ...options });
    waiting.set(agent, child);
    await event(child);
  }
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  let requeued;
  try {
    const remoteLease = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', root: box.first,
      agent: 'remote-focused', kind: 'focused', remote: true, runnerProvider: () => [{ host: 'fixture-runner', slots: 1, browser: 0 }] });
    assert.equal(remoteLease.runner?.host, 'fixture-runner', 'the only free slot is the runner, so the remote-capable run takes it');
    const requeue = remoteLease.requeueRunner();
    const gate = () => privateList(box).find(({ name }) => name === 'gate');
    while (!gate().line.some(({ agent }) => agent === 'remote-focused')) await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    const { order, line } = gate();
    const listed = line.map(({ agent, queueClass: queueClassName }) => [agent, queueClassName]);
    const ticketDb = new DatabaseSync(join(box.home, 'resources.sqlite'));
    // The pool's own processes write this file too; wait for their lock instead of failing.
    ticketDb.exec('PRAGMA busy_timeout = 5000');
    let tickets;
    let lastIssued;
    try {
      tickets = Object.fromEntries(ticketDb.prepare("SELECT agent, ticket FROM waiter WHERE name = 'gate'").all().map(({ agent, ticket }) => [agent, ticket]));
      lastIssued = ticketDb.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'waiter'").get().seq;
    } finally { ticketDb.close(); }
    const admitted = [];
    // Free the oldest held slot, watch which waiter the pool admits into it, and repeat.
    const holding = [() => release(localHolders[0]), () => release(localHolders[1])];
    while (admitted.length < 4) {
      await holding.shift()();
      const holderAgents = () => gate().holders.map(({ agent }) => agent);
      let next;
      while (!(next = [...waiting.keys(), 'remote-focused'].find((agent) => !admitted.includes(agent) && holderAgents().includes(agent)))) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      }
      admitted.push(next);
      if (next === 'remote-focused') {
        requeued = await requeue;
        assert.equal(requeued.runner, undefined, 'the quarantined runner is not used again');
        holding.push(() => { requeued.release(); requeued = null; });
      } else {
        assert.equal((await acquired(waiting.get(next))).acquired, next);
        holding.push(() => release(waiting.get(next)));
      }
    }
    for (const releaseSlot of holding) await releaseSlot();
    return { order, line: listed, admitted, tickets, lastIssued };
  } finally {
    requeued?.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
}

/** Read the next worker event, failing promptly with its stderr if it exits unexpectedly. */
async function event(child, timeoutMs = 60_000) {
  if (child.pendingLines.length) return JSON.parse(child.pendingLines.shift());
  if (child.exitResult) throw new Error(child.failure ?? `worker exited ${child.exitResult.code}/${child.exitResult.signal}: ${child.errors}`);
  const line = await new Promise((resolveLine, reject) => {
    const waiter = { resolve: resolveLine, reject, timer: setTimeout(() => {
      child.lineWaiters.splice(child.lineWaiters.indexOf(waiter), 1);
      child.failureReported = true;
      const failure = reportFixtureChildFailure({ command: child.spawnfile, args: child.spawnargs.slice(1),
        status: child.exitResult?.code ?? null, signal: child.exitResult?.signal ?? null,
        elapsedMs: performance.now() - child.startedAt, stderr: child.errors, env: child.spawnEnv,
        detail: `worker timed out waiting for its event after ${timeoutMs}ms` });
      reject(new Error(failure));
    }, timeoutMs) };
    child.lineWaiters.push(waiter);
  });
  return JSON.parse(line);
}

/** Read worker events until its real process acquires a resource place. */
async function acquired(child) {
  while (true) {
    const state = await event(child);
    if (state.acquired) return state;
  }
}

/** Read the OS process state for an exact PID under stable locale settings. */
function processState(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
  });
  return result.status === 0 ? result.stdout.trim().split(/\s+/u)[0] ?? '' : '';
}

/** Wait until the OS reports a requested process state, or fail with the last state observed. */
async function waitForProcessState(pid, state, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = processState(pid);
  while (!actual.startsWith(state) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    actual = processState(pid);
  }
  assert.ok(actual.startsWith(state), `process ${pid} has state ${actual || '(unreadable)'}, expected ${state}`);
}

/** Sleep without blocking the test runner event loop. */
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/** Wait for one private queue observation without imposing a longer lease or gate timeout. */
async function waitUntil(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Add an expired holder row to a private fixture database. */
function insertExpiredHolder(box, { name, pid, agent, started = '' }) {
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO resource(name, capacity) VALUES (?, 1)').run(name);
    db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`fixture-${agent}`, name, pid, started, agent, realpathSync(box.first), new Date(Date.now() - 60_000).toISOString(), Date.now() - 60_000);
  } finally { db.close(); }
}

/** Ask a holder to release and wait for clean process exit. */
async function release(child) {
  child.stdin.end('release\n');
  const { code } = await child.finished;
  child.lines.close();
  assert.equal(code, 0, child.errors);
}


/** Write what /proc would say: total and available memory, and the pressure stall averages. */
function writeMemoryReading(file, { availableMB, fullAvg10 = 0, someAvg10 = 0, broken = false }) {
  const meminfo = broken ? 'MemTotal: 37748736 kB\n' : `MemTotal:       37748736 kB\nMemFree:          102400 kB\nMemAvailable:   ${availableMB * 1024} kB\n`;
  const psi = `some avg10=${someAvg10.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=${fullAvg10.toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`;
  writeFileSync(file, JSON.stringify({ meminfo, psi }));
}

/** Launch one gate run through withGateSlot with an injected memory source. */
function memoryWorker(box, agent, source) {
  return poolWorker(box, { agent, script: MEMORY_WORKER, args: [box.first, agent, source] });
}


/** Kill and reap every fixture worker before deleting its private files. */
after(async () => {
  const running = [...CHILDREN];
  for (const child of running) if (!child.exitResult) child.kill('SIGKILL');
  await Promise.all(running.map((child) => child.finished));
  for (const child of running) child.lines.close();
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

export { CHILDREN, GATE_MODULE, MEMORY_WORKER, MODULE, PERL_FORK, POOL_MODULE_WORKER, PRE_RUNNER_MODULE, PROCESS_INFO_POLICY, SANDBOX_EXEC, SETTINGS_MODULE, SUBMIT_CHECK, TEMP, TEST_RUNNER, WORKER, acquired, delay, event, fixture, insertExpiredHolder, memoryWorker, poolWorker, privateList, privateTake, processState, release, requeuedRemoteRun, setBrowserFreeChecks, setQueueOrder, waitForMarker, waitForProcessState, waitUntil, worker, writeMemoryReading };
