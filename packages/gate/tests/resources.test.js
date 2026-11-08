/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/shell/cli.js */
/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
import { executionServicesSource } from '../../../test/gate-execution-fixture.js';
import { redGateReleaseSource } from '../../../test/gate-execution-fixture.js';
import { awaitNestedRun } from '../src/shell/test-file-pool.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../../test/fixture-child.js';
import { runFixtureChild as spawnSync } from '../../../test/fixture-child.js';
import { reportFixtureChildFailure } from '../../../test/fixture-child.js';
import { runFixtureChild } from '../../../test/fixture-child.js';
import { runFixtureChildAsync } from '../../../test/fixture-child.js';
import { runFixtureGit } from '../../../test/fixture-child.js';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { chmodSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
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
import { test } from 'node:test';
import { describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { listResources } from '../../resources/index.js';
import { setResourceCapacity } from '../../resources/index.js';
import { takeResource } from '../../resources/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { capacityChangeCases } from '../../../test/resources-capacity-fixture.js';
import { checkNeedsBrowser } from '../src/shell/browser-admission.js';
import { releaseQueueProof } from '../../../test/resources-release-fixture.js';
import { openPrivateScopedView } from '../../../test/resources-lease-fixture.js';
import { queuedLeaseProof } from '../../../test/resources-lease-fixture.js';
import { resourceNames } from '../../../test/resources-lease-fixture.js';
import { oldSchema } from '../../../test/resources-lease-fixture.js';
import { staleIdentity } from '../../../test/resources-lease-fixture.js';
import { expireHeartbeat } from '../../../test/resources-lease-fixture.js';
import { resourceWorkerSources } from '../../../test/resources-lease-fixture.js';
import { checkProject } from '../../../test/resources-verify-fixture.js';
import { verificationProject } from '../../../test/resources-verify-fixture.js';
import { fixtureAddArgv } from '../../../test/testkit-fixture.js';
const TEMP = [];
const CHILDREN = new Set();
const MODULE = pathToFileURL(resolve(import.meta.dirname, '../../resources/index.js')).href;
const GATE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../index.js')).href;
const LEASE_HELPERS = createE2eHelpers();
const PRE_RUNNER_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../test/fixtures/resources-pre-runners.js')).href;
const SETTINGS_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../config/src/shell/settings.js')).href;
const BIN = resolve(import.meta.dirname, '../../../bin/pullboard.js');
const TEST_RUNNER = resolve(import.meta.dirname, '../../../bin/run-tests.js');
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
  return { dir, home, first, second, env: { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home } };
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

/** Configure browser slots through the public CLI in this fixture's private machine home. */
function configureBrowserSlots(box, slots) {
  return runFixtureChild(process.execPath, [BIN, 'settings', 'browserSlots', String(slots), '--json'], {
    cwd: box.first, env: box.env, encoding: 'utf8',
  });
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

test('single-quoted named-test checks skip the browser slot [C7]', async () => {
  const box = fixture();
  const { repo } = checkProject(box);
  const itemCheck = 'node bin/run-tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  /** Keep assertions about the parser independent of worker custody inherited by the test process. */
  const classify = command => checkNeedsBrowser(repo, command, { env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(await classify(itemCheck), false, 'an explicit CPU-only test file is classifiable');
  const outputPattern = '^[[:space:]]*ok [0-9]+ - item check marker';
  const newlinePrint = ([quote, backslashes]) => `printf ${quote}%s${'\\'.repeat(backslashes)}n${quote} "$out"`;
  const capturedCheck = (formats, patternQuotes) => `out=$(${itemCheck} 2>&1); ${newlinePrint(formats[0])}; ${newlinePrint(formats[1])} | grep -Eq ${patternQuotes[0]}${outputPattern}${patternQuotes[0]} && ${newlinePrint(formats[2])} | grep -Eq ${patternQuotes[1]}^# fail 0$${patternQuotes[1]}`;
  const oneBackslash = [1, 1, 1];
  const accepted = [
    { formats: oneBackslash.map(count => ['\'', count]), patternQuotes: ['\'', '\''] },
    { formats: [['\'', 1], ['"', 1], ['\'', 1]], patternQuotes: ['"', '\''] },
    { formats: [['"', 1], ['\'', 1], ['"', 1]], patternQuotes: ['\'', '"'] },
    { formats: oneBackslash.map(count => ['"', count]), patternQuotes: ['"', '"'] },
  ];
  for (const variant of accepted) {
    assert.equal(await classify(capturedCheck(variant.formats, variant.patternQuotes)), false,
      `the exact capture wrapper accepts quote changes with one literal backslash: ${JSON.stringify(variant)}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const formats = oneBackslash.map(count => ['\'', count]);
    formats[index] = ['\'', 2];
    assert.equal(await classify(capturedCheck(formats, ['\'', '\''])), true,
      `a two-backslash printf at position ${index + 1} stays browser-gated`);
  }
  assert.equal(await classify(`${capturedCheck(accepted[0].formats, accepted[0].patternQuotes)}; :`), true,
    'an arbitrary suffix remains outside the exact capture wrapper');
  const substituted = capturedCheck(accepted[0].formats, accepted[0].patternQuotes)
    .replace('printf \'%s\\n\' "$out"', 'printf \'%s\\n\' "$(printf %s "$out")"');
  assert.equal(await classify(substituted), true, 'a command substitution remains outside the exact printf wrapper');
  assert.equal(await classify('node bin/run-tests.js test/cockpit/brief.test.js'), true,
    'a named file with no readable declaration stays browser-gated');
  assert.equal(await checkNeedsBrowser(repo, itemCheck, {
    env: { ...process.env, NODE_OPTIONS: '--import=unknown-preload.mjs' },
  }), true, 'an unclassified preload keeps the check browser-gated');
});

test('a non-browser check does not wait for the browser slot [C7]', async () => {
  const box = fixture();
  setBrowserFreeChecks(box, true);
  const { repo, base } = checkProject(box);
  const itemCheck = 'node bin/run-tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  const submitCheck = 'node bin/run-tests.js --test-name-pattern "submit check marker" test/cpu-check.test.js';
  const classifyEnv = { ...process.env, NODE_OPTIONS: '' };
  assert.equal(await checkNeedsBrowser(repo, itemCheck, { env: classifyEnv }), false, 'an explicit CPU-only test file is classifiable');
  assert.equal(await checkNeedsBrowser(repo, 'node bin/run-tests.js test/cockpit/brief.test.js', { env: classifyEnv }), true,
    'a named file with no readable declaration stays browser-gated');
  const added = runFixtureChild(process.execPath, [...fixtureAddArgv(BIN), 'coordinator', 'CPU check item', '--check', itemCheck, '--wait', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(added.status, 0, added.stderr);
  const item = JSON.parse(added.stdout).item.item_id;
  assert.equal(existsSync(join(repo, 'item-check-started')), false, 'the setup baseline ran in its private clone');

  const browserHolder = poolWorker(box, { agent: 'check-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(browserHolder);
  const itemMarker = join(repo, 'item-check-started');
  const itemStarted = waitForMarker(itemMarker);
  const itemRun = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
  let itemResult;
  try {
    await itemStarted;
    assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'check-browser-holder'),
      'the item check starts while the unrelated browser lease remains held');
  } finally {
    await release(browserHolder);
    itemResult = await itemRun;
  }
  assert.equal(itemResult.status, 0, itemResult.failure ?? itemResult.stderr);
  assert.equal(readFileSync(itemMarker, 'utf8'), 'started');

  const nextBrowserHolder = poolWorker(box, { agent: 'submit-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(nextBrowserHolder);
  const submitMarker = join(repo, 'submit-check-started');
  const submitStarted = waitForMarker(submitMarker);
  const submitRun = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', SUBMIT_CHECK, repo, base, submitCheck], { cwd: repo, env: box.env });
  let submitResult;
  let submitStartFailure = null;
  try {
    try { await submitStarted; }
    catch (error) { submitStartFailure = error; }
    assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'submit-browser-holder'),
      'the submission check starts while the unrelated browser lease remains held');
  } finally {
    await release(nextBrowserHolder);
    submitResult = await submitRun;
  }
  assert.equal(submitStartFailure, null, `${submitStartFailure?.message ?? ''}\n${submitResult.stdout}\n${submitResult.stderr}`);
  assert.equal(submitResult.status, 0, submitResult.failure ?? submitResult.stderr);
  assert.deepEqual(JSON.parse(submitResult.stdout), {
    green: true, full: false, reason: '', files: ['test/cpu-check.test.js'], checkGreen: true,
  }, submitResult.stderr);
});

test('browser-free checks skip the slot only when the machine allows it [C7]', async () => {
  const box = fixture();
  const { repo } = checkProject(box);
  const check = `out=$(node bin/run-tests.js --test-name-pattern "item check marker" test/cpu-check.test.js 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | grep -Eq '^[[:space:]]*ok [0-9]+ - item check marker' && printf '%s\\n' "$out" | grep -Eq '^# fail 0$'`;
  const added = runFixtureChild(process.execPath, [...fixtureAddArgv(BIN), 'coordinator', 'Browser-free policy check', '--check', check, '--wait', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(added.status, 0, added.stderr);
  const item = JSON.parse(added.stdout).item.item_id;
  const marker = join(repo, 'item-check-started');

  async function checkWithPolicy(value, shouldStartWithBrowserHeld) {
    setBrowserFreeChecks(box, value);
    rmSync(marker, { force: true });
    const browserHolder = poolWorker(box, { agent: `policy-browser-${String(value)}`, browser: true, item: '681', kind: 'gate' });
    await acquired(browserHolder);
    const started = waitForMarker(marker);
    const startedOutcome = started.then(() => null, error => error);
    const resultPromise = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
    let result;
    try {
      if (shouldStartWithBrowserHeld) {
        await started;
        assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === `policy-browser-${String(value)}`),
          'the browser lease stays live while an opted-in browser-free check runs');
      } else {
        await waitUntil(() => privateList(box).find(({ name }) => name === 'gate')?.line.some(({ kind, item: waitingItem }) => kind === 'check' && waitingItem === String(item)),
          'a browser-disabled check to wait in the gate queue');
        assert.equal(existsSync(marker), false, 'the check does not start while browser-free checks are disabled or absent');
      }
    } finally {
      await release(browserHolder);
      result = await resultPromise;
    }
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    assert.equal(await startedOutcome, null, 'the check marker observer settles and closes');
    assert.equal(readFileSync(marker, 'utf8'), 'started');
  }

  await checkWithPolicy(false, false);
  await checkWithPolicy(true, true);
  await checkWithPolicy(undefined, false);
});

/** Kill and reap every fixture worker before deleting its private files. */
after(async () => {
  const running = [...CHILDREN];
  for (const child of running) if (!child.exitResult) child.kill('SIGKILL');
  await Promise.all(running.map((child) => child.finished));
  for (const child of running) child.lines.close();
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  LEASE_HELPERS.cleanup();
});

test('a review waiting in the pool keeps its lease [C7,V4]', {
  timeout: 120_000, // budget: real private Git/CLI setup and causally controlled queue/run/death phases, never a production lease extension.
}, (t) => queuedLeaseProof(t, { helpers: LEASE_HELPERS, children: CHILDREN, fixture, poolWorker, privateList, privateTake, acquired, release, waitUntil }));

/** Prove the machine setting changes real browser admission while retaining the single-slot default [C7]. */
test('browserSlots admits that many browser runs and no more [C7]', async () => {
  const defaults = fixture();
  const defaultSettings = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], {
    cwd: defaults.first, env: defaults.env, encoding: 'utf8',
  });
  assert.equal(defaultSettings.status, 0, defaultSettings.stderr);
  assert.equal(JSON.parse(defaultSettings.stdout).settings.browserSlots, 1, 'an unset machine keeps the existing single browser slot');

  const box = fixture();
  const configured = configureBrowserSlots(box, 2);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(JSON.parse(configured.stdout).settings.browserSlots, 2);
  const readBack = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], {
    cwd: box.first, env: box.env, encoding: 'utf8',
  });
  assert.equal(readBack.status, 0, readBack.stderr);
  assert.equal(JSON.parse(readBack.stdout).settings.browserSlots, 2, 'the machine setting persists for other processes');
  assert.equal(privateList(box).find(({ name }) => name === 'browser').capacity, 2,
    'the shared browser resource row has the configured capacity before workers start');
  const invalid = configureBrowserSlots(box, 3);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'BAD_BROWSER_SLOTS');
  assert.match(JSON.parse(invalid.stdout).error.message, /pullboard settings gateSlots/u);

  const first = poolWorker(box, { agent: 'browser-one', browser: true });
  assert.equal((await acquired(first)).acquired, 'browser-one');
  const second = poolWorker(box, { agent: 'browser-two', browser: true });
  const secondStart = await event(second);
  if (!secondStart.acquired) {
    const gate = privateList(box).find(({ name }) => name === 'gate');
    const browser = privateList(box).find(({ name }) => name === 'browser');
    assert.fail(`the configured second browser lease queued: ${JSON.stringify({ state: secondStart.queued, gate, browser })}`);
  }
  assert.equal(secondStart.acquired, 'browser-two', 'the configured second browser lease starts while the first is held');
  const third = poolWorker(box, { agent: 'browser-three', browser: true });
  assert.equal((await event(third)).queued.position, 1, 'the next browser run waits for a configured slot');
  const browser = privateList(box).find(({ name }) => name === 'browser');
  assert.equal(browser.capacity, 2, 'resource listing reflects the machine browserSlots setting');
  assert.equal(browser.holders.length, 2);
  assert.deepEqual(browser.holders.map(({ agent }) => agent).sort(), ['browser-one', 'browser-two']);
  assert.deepEqual(browser.line.map(({ agent }) => agent), ['browser-three']);

  await release(first);
  assert.equal((await acquired(third)).acquired, 'browser-three', 'a released browser lease admits the oldest waiting browser run');
  await release(second);
  await release(third);
});

// These cases keep all asynchronous state in separate child processes and private machine homes.
// Their only parent environment changes are synchronous reads restored before yielding.
describe('isolated resource queue scenarios [C7,Q1,Q2]', { concurrency: 4 }, () => {
test('[Q1,Q2] capacity-one takers acquire in strict FIFO arrival order', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiting = [];
  let firstQueuedAt = 0;
  for (const agent of ['first', 'second', 'third']) {
    const child = worker(box, { agent });
    waiting.push(child);
    const state = await event(child);
    assert.equal(state.waiting, waiting.length, `${agent} reports its FIFO place`);
    assert.equal(state.holders[0].agent, 'holder', `${agent} says who holds the place`);
    if (agent === 'first') {
      assert.equal(state.holders[0].repo, realpathSync(box.first), 'machine-scope listings still identify the Git root');
      firstQueuedAt = Date.parse(state.line[0].since);
      assert.ok(Number.isFinite(firstQueuedAt));
    }
  }
  const order = [];
  let current = holder;
  for (const [index, child] of waiting.entries()) {
    await release(current);
    assert.equal((await event(child)).acquired, ['first', 'second', 'third'][index]);
    if (index === 0) {
      const displayed = privateList(box).find((resource) => resource.name === 'gate').holders[0];
      assert.ok(Date.parse(displayed.since) > firstQueuedAt, 'holder since is when capacity was acquired, not when it joined the queue');
    }
    order.push(['first', 'second', 'third'][index]);
    current = child;
  }
  await release(current);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('[Q1,Q2] landing waiters jump ordinary gates but keep FIFO within each class [Q1,Q2]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const ordinaryFirst = worker(box, { agent: 'ordinary-first' });
  assert.equal((await event(ordinaryFirst)).waiting, 1);
  const landingFirst = worker(box, { agent: 'landing-first', landing: true });
  assert.equal((await event(landingFirst)).waiting, 1);
  const ordinarySecond = worker(box, { agent: 'ordinary-second' });
  assert.equal((await event(ordinarySecond)).waiting, 3);
  const landingSecond = worker(box, { agent: 'landing-second', landing: true });
  assert.equal((await event(landingSecond)).waiting, 2);
  const listed = privateList(box)[0].line;
  assert.deepEqual(listed.map(({ agent, landing }) => [agent, landing]), [
    ['landing-first', true], ['landing-second', true], ['ordinary-first', false], ['ordinary-second', false],
  ]);

  await release(holder);
  assert.equal((await event(landingFirst)).acquired, 'landing-first');
  await release(landingFirst);
  assert.equal((await event(landingSecond)).acquired, 'landing-second');
  await release(landingSecond);
  assert.equal((await event(ordinaryFirst)).acquired, 'ordinary-first');
  await release(ordinaryFirst);
  assert.equal((await event(ordinarySecond)).acquired, 'ordinary-second');
  await release(ordinarySecond);
});

test('the pool alone orders submits, reviews and browser runs [C7]', async () => {
  const orderBox = fixture();
  const orderHolder = poolWorker(orderBox, { agent: 'order-holder' });
  const otherHolder = poolWorker(orderBox, { agent: 'other-holder' });
  assert.equal((await acquired(orderHolder)).acquired, 'order-holder');
  assert.equal((await acquired(otherHolder)).acquired, 'other-holder');

  const olderReview = poolWorker(orderBox, { agent: 'older-review', browser: true, item: '620', kind: 'review' });
  assert.equal((await event(olderReview)).queued.position, 1);
  const laterFocused = poolWorker(orderBox, { agent: 'later-focused', kind: 'focused' });
  assert.ok((await event(laterFocused)).queued, 'later focused work has joined behind the review');

  await release(orderHolder);
  await waitUntil(() => privateList(orderBox).find(({ name }) => name === 'gate').holders
    .some(({ agent }) => agent === 'older-review' || agent === 'later-focused'), 'the first eligible waiter to acquire');
  let orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.ok(orderedGate.holders.some(({ agent, itemCheck, item }) =>
    agent === 'older-review' && itemCheck && item === '620'),
  'an older eligible review stays ahead of later focused work');
  assert.ok(!orderedGate.holders.some(({ agent }) => agent === 'later-focused'),
    'later focused work cannot jump the older review');
  assert.equal((await acquired(olderReview)).acquired, 'older-review');

  const diagnosticOne = poolWorker(orderBox, { agent: 'diagnostic-one', kind: 'diagnostic' });
  assert.equal((await event(diagnosticOne)).queued.position, 2);
  const laterReview = poolWorker(orderBox, { agent: 'later-review', item: '621', kind: 'review' });
  assert.equal((await event(laterReview)).queued.position, 3);
  const diagnosticTwo = poolWorker(orderBox, { agent: 'diagnostic-two', kind: 'diagnostic' });
  assert.equal((await event(diagnosticTwo)).queued.position, 4);
  const laterGate = poolWorker(orderBox, { agent: 'later-gate', kind: 'focused' });
  assert.equal((await event(laterGate)).queued.position, 5);
  const laterLanding = poolWorker(orderBox, { agent: 'later-landing', landing: true });
  await event(laterLanding);
  orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.deepEqual(orderedGate.line.map(({ agent, landing, diagnostic, itemCheck, kind }) =>
    [agent, landing, diagnostic === true, itemCheck, kind ?? '']), [
    ['later-landing', true, false, false, ''],
    ['later-focused', false, false, false, 'focused'],
    ['diagnostic-one', false, true, false, 'diagnostic'],
    ['later-review', false, false, true, 'review'],
    ['diagnostic-two', false, true, false, 'diagnostic'],
    ['later-gate', false, false, false, 'focused'],
  ], 'landing moves ahead while all other kinds retain their arrival order');

  await release(otherHolder);
  assert.equal((await acquired(laterLanding)).acquired, 'later-landing',
    'a later landing jumps the older focused and diagnostic waiters');
  orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.ok(orderedGate.holders.some(({ agent, landing }) => agent === 'later-landing' && landing));

  await release(laterLanding);
  assert.equal((await acquired(laterFocused)).acquired, 'later-focused',
    'the oldest eligible non-landing waiter acquires next');
  await release(laterFocused);
  assert.equal((await acquired(diagnosticOne)).acquired, 'diagnostic-one');
  await release(diagnosticOne);
  assert.equal((await acquired(laterReview)).acquired, 'later-review',
    'a diagnostic does not yield its older ticket to a later item check');
  await release(laterReview);
  assert.equal((await acquired(diagnosticTwo)).acquired, 'diagnostic-two',
    'diagnostics keep their FIFO place around a later item check');
  await release(diagnosticTwo);
  assert.equal((await acquired(laterGate)).acquired, 'later-gate',
    'a diagnostic does not yield its older ticket to later ordinary gate work');
  await release(laterGate);
  await release(olderReview);

  const box = fixture();
  const firstHolder = poolWorker(box, { agent: 'submit-one' });
  const secondHolder = poolWorker(box, { agent: 'submit-two' });
  assert.equal((await acquired(firstHolder)).acquired, 'submit-one');
  assert.equal((await acquired(secondHolder)).acquired, 'submit-two');

  const firstReview = poolWorker(box, { agent: 'review-one', browser: true, item: '618', kind: 'review' });
  const firstQueued = await event(firstReview);
  assert.equal(firstQueued.queued.position, 1, 'a review waits while both submit slots are occupied');
  let browser = privateList(box).find(({ name }) => name === 'browser');
  assert.ok(browser, 'the pool must expose browser capacity and its waiting review');
  assert.equal(browser.capacity, 1, 'the browser pool has its fixed single slot');
  assert.deepEqual(browser.line.map(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    [agent, ownsBrowser, itemCheck, item, kind]), [['review-one', true, true, '618', 'review']]);

  // Releasing one holder is the only signal; the oldest eligible review acquires on its own poll.
  await release(firstHolder);
  assert.equal((await acquired(firstReview)).acquired, 'review-one');
  let gate = privateList(box).find(({ name }) => name === 'gate');
  assert.ok(gate.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-one' && ownsBrowser && itemCheck && item === '618' && kind === 'review'));

  const secondReview = poolWorker(box, { agent: 'review-two', browser: true, item: '619', kind: 'review' });
  const secondQueued = await event(secondReview);
  assert.equal(secondQueued.queued.position, 1, 'the browser waiter reports its actual queue position');
  const thirdSubmit = poolWorker(box, { agent: 'submit-three' });
  const submitQueued = await event(thirdSubmit);
  assert.equal(submitQueued.queued.position, 2,
    'the visible queue preserves FIFO position behind its earlier browser waiter');
  browser = privateList(box).find(({ name }) => name === 'browser');
  assert.deepEqual(browser.line.map(({ agent, itemCheck, item, kind }) => [agent, itemCheck, item, kind]), [
    ['review-two', true, '619', 'review'],
  ], 'the active browser review is listed as a holder, not as a waiter');
  assert.ok(browser.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-one' && ownsBrowser && itemCheck && item === '618' && kind === 'review'));

  // A free gate slot appears while the browser slot remains held; the queued submit proceeds.
  await release(secondHolder);
  assert.equal((await acquired(thirdSubmit)).acquired, 'submit-three');
  assert.ok(privateList(box).find(({ name }) => name === 'browser').line
    .some(({ agent }) => agent === 'review-two'), 'the second review stays queued while the browser slot is occupied');

  // Releasing both older leases lets the oldest eligible browser waiter proceed without a message.
  await release(thirdSubmit);
  await release(firstReview);
  assert.equal((await acquired(secondReview)).acquired, 'review-two');
  gate = privateList(box).find(({ name }) => name === 'gate');
  assert.ok(gate.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-two' && ownsBrowser && itemCheck && item === '619' && kind === 'review'));
  await release(secondReview);
});

});

test('the pool admits reviews before submits before focused runs, and waiting runs age up [C7,V4]', async () => {
  const AGE_MS = 30 * 60_000;
  const box = fixture();
  setQueueOrder(box, { reviewsFirst: true }); // #697: class order is a machine opt-in.
  const holders = [poolWorker(box, { agent: 'holder-one' }), poolWorker(box, { agent: 'holder-two' })];
  for (const holder of holders) await acquired(holder);
  const waiting = new Map();
  const positions = {};
  for (const [agent, options] of [
    ['focused-one', { kind: 'focused' }],
    ['diagnostic-one', { kind: 'diagnostic' }],
    ['submit-one', { kind: 'submit', item: '650' }],
    ['review-one', { kind: 'review', item: '651' }],
    ['landing-one', { landing: true }],
    ['focused-two', { kind: 'focused' }],
  ]) {
    const child = poolWorker(box, { agent, ...options });
    waiting.set(agent, child);
    positions[agent] = (await event(child)).queued.position;
  }
  assert.deepEqual(positions, { 'focused-one': 1, 'diagnostic-one': 2, 'submit-one': 1, 'review-one': 1, 'landing-one': 1, 'focused-two': 6 },
    'each arrival takes its place by class, behind earlier runs of its own class');
  const line = () => privateList(box).find(({ name }) => name === 'gate').line
    .map(({ agent, queueClass: listed, agedFrom }) => [agent, listed, agedFrom ?? '']);
  assert.deepEqual(line(), [
    ['landing-one', 'landing', ''],
    ['review-one', 'review', ''],
    ['submit-one', 'submit', ''],
    ['focused-one', 'other', ''],
    ['diagnostic-one', 'other', ''],
    ['focused-two', 'other', ''],
  ], 'landing, then reviews, then submits, then focused and other runs, first come first served within each');

  // Waiting time is the only input to aging; backdating the queued time stands in for the clock.
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  // The pool's own processes write this file too; wait for their lock instead of failing.
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const backdate = db.prepare('UPDATE waiter SET since = ? WHERE agent = ?');
    backdate.run(new Date(Date.now() - 2 * AGE_MS - 60_000).toISOString(), 'focused-two');
    backdate.run(new Date(Date.now() - AGE_MS - 60_000).toISOString(), 'diagnostic-one');
  } finally { db.close(); }
  assert.deepEqual(line(), [
    ['landing-one', 'landing', ''],
    ['review-one', 'review', ''],
    ['focused-two', 'review', 'other'],
    ['diagnostic-one', 'submit', 'other'],
    ['submit-one', 'submit', ''],
    ['focused-one', 'other', ''],
  ], 'a run waiting an hour ranks with reviews and one waiting half an hour with submits, keeping its arrival place there');

  const order = [];
  let releasing = [...holders];
  for (const agent of ['landing-one', 'review-one', 'focused-two', 'diagnostic-one', 'submit-one', 'focused-one']) {
    await release(releasing.shift());
    const child = waiting.get(agent);
    assert.equal((await acquired(child)).acquired, agent, `${agent} is admitted next`);
    order.push(agent);
    releasing.push(child);
  }
  for (const child of releasing) await release(child);
  assert.deepEqual(order, ['landing-one', 'review-one', 'focused-two', 'diagnostic-one', 'submit-one', 'focused-one']);

  // A remote run whose runner drops is requeued with its original arrival ticket: it sits behind
  // earlier runs of its own class and behind waiting reviews and submits, and the line stays in
  // class order (the requeue is marked classed, so it never forces arrival).
  const requeued = await requeuedRemoteRun({ reviewsFirst: true });
  assert.equal(requeued.order, undefined, 'a requeued remote waiter is marked as class-ordered, so the pool keeps class order');
  assert.deepEqual(requeued.line, [
    ['review-later', 'review'], ['submit-later', 'submit'], ['focused-early', 'other'], ['remote-focused', 'other'],
  ], 'the requeued remote run keeps first come, first served in its class, behind the earlier focused run');
  assert.equal(requeued.tickets['remote-focused'], requeued.lastIssued, 'the requeued runner waiter keeps its original ticket, the last one issued');
  assert.ok(requeued.tickets['focused-early'] < requeued.tickets['remote-focused'], 'an earlier same-class waiter keeps its earlier ticket');
  assert.deepEqual(requeued.admitted, ['review-later', 'submit-later', 'focused-early', 'remote-focused']);

  // The class rule itself, against an injected clock rather than real waiting.
  const { QUEUE_AGE_MS, queueClass } = await import('../../resources/index.js');
  const queuedAt = Date.parse('2026-10-15T19:37:00.000Z');
  const at = (minutes) => queuedAt + minutes * 60_000;
  const since = new Date(queuedAt).toISOString();
  assert.equal(QUEUE_AGE_MS, 30 * 60_000, 'a waiter moves up one class every 30 minutes');
  assert.deepEqual([0, 29, 30, 60, 90, 300].map((minutes) => queueClass({ kind: 'focused', since }, at(minutes)).name),
    ['other', 'other', 'submit', 'review', 'landing', 'landing'], 'a focused run ages up one class per 30 minutes waited');
  assert.equal(queueClass({ kind: 'review', since }, at(30)).name, 'landing');
  assert.equal(queueClass({ kind: 'main-red', diagnostic: 1, itemCheck: 1, since }, at(0)).name, 'other', 'a diagnostic is optional work');
  assert.equal(queueClass({ kind: 'check', itemCheck: 1, since }, at(0)).name, 'submit', 'an item check ranks with submits');
  assert.equal(queueClass({ landing: 1, since }, at(0)).name, 'landing');
});

describe('isolated mixed-version and release queues [C7,Q1,Q2]', { concurrency: 4 }, () => {
test('a line holding an older pullboard waiter keeps arrival order, so mixed versions never deadlock [C7]', async () => {
  const box = fixture();
  setQueueOrder(box, { reviewsFirst: true }); // #697: class order is a machine opt-in.
  const holders = [poolWorker(box, { agent: 'mixed-holder-one' }), poolWorker(box, { agent: 'mixed-holder-two' })];
  for (const holder of holders) await acquired(holder);
  // A real older pullboard (before #651) writes no class marker; it admits landings first and then by ticket.
  const older = poolWorker(box, { agent: 'older-focused', kind: 'focused', module: PRE_RUNNER_MODULE });
  await event(older);
  const review = poolWorker(box, { agent: 'newer-review', kind: 'review', item: '651' });
  assert.equal((await event(review)).queued.position, 2, 'the review waits behind the older waiter\'s earlier ticket');
  const gate = () => privateList(box).find(({ name }) => name === 'gate');
  assert.equal(gate().order, 'arrival');
  assert.deepEqual(gate().line.map(({ agent }) => agent), ['older-focused', 'newer-review']);

  await release(holders[0]);
  assert.equal((await acquired(older)).acquired, 'older-focused', 'both versions agree the earlier ticket goes first');
  assert.equal(gate().order, undefined, 'class order resumes once only marked waiters remain');
  await release(holders[1]);
  assert.equal((await acquired(review)).acquired, 'newer-review');
  await release(older);
  await release(review);
});

test('the gate pool serves the current release first [C7,V4]', () => releaseQueueProof({ fixture, poolWorker, privateList, event, acquired, release, legacyModule: PRE_RUNNER_MODULE }));

});

test('queue order follows the machine settings [C7,O5]', async () => {
  const gate = (box) => privateList(box).find(({ name }) => name === 'gate');
  const line = (box) => gate(box).line.map(({ agent, queueClass: listed, agedFrom }) => [agent, listed, agedFrom ?? '']);
  /** Backdate a waiter's queued time: the test clock that stands in for real waiting. */
  const backdate = (box, agent, ms) => {
    const queuedAt = new Date(Date.now() - ms).toISOString();
    const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
    // The pool's own processes write this file too; wait for their lock instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    let changed;
    try { changed = db.prepare('UPDATE waiter SET since = ? WHERE agent = ?').run(queuedAt, agent).changes; }
    finally { db.close(); }
    assert.equal(changed, 1, `${agent} has a private waiter row`);
  };
  /** Run pullboard settings against the fixture's private machine home. */
  const settingsCli = (box, ...flags) => runFixtureChild(process.execPath, [BIN, 'settings', ...flags], { cwd: box.first, env: box.env, encoding: 'utf8' });

  // No settings: landings first, then arrival, so a review waits behind an earlier focused run.
  const plain = fixture();
  const plainHolders = [poolWorker(plain, { agent: 'plain-holder-one' }), poolWorker(plain, { agent: 'plain-holder-two' })];
  for (const holder of plainHolders) await acquired(holder);
  const plainFocused = poolWorker(plain, { agent: 'plain-focused', kind: 'focused' });
  assert.equal((await event(plainFocused)).queued.position, 1);
  const plainReview = poolWorker(plain, { agent: 'plain-review', kind: 'review', item: '697' });
  assert.equal((await event(plainReview)).queued.position, 2, 'with no settings a review waits its arrival turn');
  assert.deepEqual(gate(plain).line.map(({ agent }) => agent), ['plain-focused', 'plain-review'], 'with no settings the line is in arrival order');
  // agingMinutes alone does nothing: aging is used only while a class order is on.
  setQueueOrder(plain, { agingMinutes: 1 });
  backdate(plain, 'plain-review', 5 * 60_000);
  assert.deepEqual(line(plain), [['plain-focused', 'other', ''], ['plain-review', 'review', '']],
    'with reviewsFirst off no waiter ages up, even with a short agingMinutes');
  setQueueOrder(plain, undefined);
  const plainPrinted = settingsCli(plain);
  assert.equal(plainPrinted.status, 0, plainPrinted.stderr);
  assert.match(plainPrinted.stdout, /^gate\.queue\.reviewsFirst: false\b/mu, 'pullboard settings prints reviewsFirst, default false');
  assert.match(plainPrinted.stdout, /^gate\.queue\.agingMinutes: 30\b/mu, 'pullboard settings prints agingMinutes, default 30');
  await release(plainHolders[0]);
  assert.equal((await acquired(plainFocused)).acquired, 'plain-focused', 'with no settings the earlier focused run is admitted first');
  await release(plainHolders[1]);
  assert.equal((await acquired(plainReview)).acquired, 'plain-review');
  await release(plainFocused);
  await release(plainReview);

  // reviewsFirst true: the same review is admitted ahead of the earlier focused run.
  const classed = fixture();
  setQueueOrder(classed, { reviewsFirst: true });
  const classedHolders = [poolWorker(classed, { agent: 'classed-holder-one' }), poolWorker(classed, { agent: 'classed-holder-two' })];
  for (const holder of classedHolders) await acquired(holder);
  const classedFocused = poolWorker(classed, { agent: 'classed-focused', kind: 'focused' });
  assert.equal((await event(classedFocused)).queued.position, 1);
  const classedReview = poolWorker(classed, { agent: 'classed-review', kind: 'review', item: '697' });
  assert.equal((await event(classedReview)).queued.position, 1, 'with reviewsFirst true a review joins ahead of focused runs');
  assert.deepEqual(gate(classed).line.map(({ agent }) => agent), ['classed-review', 'classed-focused'], 'with reviewsFirst true the line is in class order');
  await release(classedHolders[0]);
  assert.equal((await acquired(classedReview)).acquired, 'classed-review', 'with reviewsFirst true the review is admitted first');
  await release(classedHolders[1]);
  assert.equal((await acquired(classedFocused)).acquired, 'classed-focused');
  await release(classedReview);
  await release(classedFocused);

  // agingMinutes 1: a focused run waiting just over a minute moves up one class, ahead of a later submit.
  const aging = fixture();
  setQueueOrder(aging, { reviewsFirst: true, agingMinutes: 1 });
  const agingHolders = [poolWorker(aging, { agent: 'aging-holder-one' }), poolWorker(aging, { agent: 'aging-holder-two' })];
  for (const holder of agingHolders) await acquired(holder);
  const agingFocused = poolWorker(aging, { agent: 'aging-focused', kind: 'focused' });
  await event(agingFocused);
  const agingSubmit = poolWorker(aging, { agent: 'aging-submit', kind: 'submit', item: '697' });
  assert.equal((await event(agingSubmit)).queued.position, 1, 'a fresh submit goes ahead of a fresh focused run');
  assert.deepEqual(line(aging), [['aging-submit', 'submit', ''], ['aging-focused', 'other', '']]);
  backdate(aging, 'aging-focused', 61_000);
  assert.deepEqual(line(aging), [['aging-focused', 'submit', 'other'], ['aging-submit', 'submit', '']],
    'after agingMinutes 1 the focused run ranks with submits and keeps its earlier ticket there');
  const agingPrinted = settingsCli(aging);
  assert.equal(agingPrinted.status, 0, agingPrinted.stderr);
  assert.match(agingPrinted.stdout, /^gate\.queue\.reviewsFirst: true$/mu, 'pullboard settings prints the reviewsFirst set on this machine');
  assert.match(agingPrinted.stdout, /^gate\.queue\.agingMinutes: 1$/mu, 'pullboard settings prints the agingMinutes set on this machine');
  assert.deepEqual(JSON.parse(settingsCli(aging, '--json').stdout).settings.gate.queue, { reviewsFirst: true, currentReleaseFirst: false, agingMinutes: 1 });
  await release(agingHolders[0]);
  assert.equal((await acquired(agingFocused)).acquired, 'aging-focused', 'the aged focused run is admitted before the later submit');
  await release(agingHolders[1]);
  assert.equal((await acquired(agingSubmit)).acquired, 'aging-submit');
  await release(agingFocused);
  await release(agingSubmit);
  // The class rule against an injected clock: one class per agingMinutes waited.
  const { queueClass } = await import('../../resources/index.js');
  const queuedAt = Date.parse('2026-10-16T16:00:00.000Z');
  const since = new Date(queuedAt).toISOString();
  assert.deepEqual([0, 0.99, 1, 2, 3].map((minutes) => queueClass({ kind: 'focused', since }, queuedAt + minutes * 60_000, 60_000).name),
    ['other', 'other', 'submit', 'review', 'landing'], 'a one-minute aging moves a waiting run up one class per minute');

  // A remote run whose runner drops is requeued: with no settings it takes #663's front ticket,
  // ahead of every other non-landing waiter, as before; with reviewsFirst true it keeps its original
  // ticket, so it waits behind an earlier run of its own class, and the pool stays in class order
  // (the requeue is marked classed, so it never forces arrival).
  const requeuedOff = await requeuedRemoteRun(undefined);
  assert.equal(requeuedOff.order, undefined);
  assert.deepEqual(requeuedOff.line, [
    ['remote-focused', 'other'], ['focused-early', 'other'], ['submit-later', 'submit'], ['review-later', 'review'],
  ], 'with no settings the requeued remote run goes first and the rest keep arrival order');
  assert.ok(requeuedOff.tickets['remote-focused'] < 0, 'with no settings the requeued run takes the front ticket, as on main');
  assert.deepEqual(requeuedOff.admitted, ['remote-focused', 'focused-early', 'submit-later', 'review-later']);
  const requeuedOn = await requeuedRemoteRun({ reviewsFirst: true });
  assert.equal(requeuedOn.order, undefined, 'with reviewsFirst true a requeued remote run keeps the pool in class order');
  assert.deepEqual(requeuedOn.line, [
    ['review-later', 'review'], ['submit-later', 'submit'], ['focused-early', 'other'], ['remote-focused', 'other'],
  ], 'with reviewsFirst true the requeued remote run keeps its arrival place in its class');
  assert.equal(requeuedOn.tickets['remote-focused'], requeuedOn.lastIssued, 'with reviewsFirst true the requeued run keeps its original ticket');
  assert.deepEqual(requeuedOn.admitted, ['review-later', 'submit-later', 'focused-early', 'remote-focused']);

  // Mixed versions agree on the next waiter. A #651-only process ranks by class only when every
  // waiter is marked classed=1, and otherwise landings first, then ticket; a #697 process follows
  // its setting and marks its waiters to match, so both rankers pick the same waiter off and on.
  const { queueClass: classOf } = await import('../../resources/index.js');
  const agree = fixture();
  const agreeHolders = [poolWorker(agree, { agent: 'agree-holder-one' }), poolWorker(agree, { agent: 'agree-holder-two' })];
  for (const holder of agreeHolders) await acquired(holder);
  const agreeFocused = poolWorker(agree, { agent: 'agree-focused', kind: 'focused' });
  await event(agreeFocused);
  const agreeReview = poolWorker(agree, { agent: 'agree-review', kind: 'review', item: '697' });
  await event(agreeReview);
  /** The raw waiter rows every process reads. */
  const rows = () => {
    const db = new DatabaseSync(join(agree.home, 'resources.sqlite'));
    // The pool's own processes write this file too; wait for their lock instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    try { return db.prepare("SELECT ticket, agent, since, landing, item_check AS itemCheck, diagnostic, kind, classed FROM waiter WHERE name = 'gate'").all(); }
    finally { db.close(); }
  };
  /** The next waiter as a #651-only process ranks the same rows. */
  const next651 = (waiters) => {
    const byClass = waiters.every((waiter) => waiter.classed === 1);
    const rank = (waiter) => (byClass ? classOf(waiter).effective : waiter.landing === 1 ? 0 : 1);
    return [...waiters].sort((left, right) => rank(left) - rank(right) || left.ticket - right.ticket)[0].agent;
  };
  assert.deepEqual(rows().map(({ classed }) => classed), [0, 0], 'with reviewsFirst off a waiter is marked as not admitting by class');
  assert.equal(next651(rows()), gate(agree).line[0].agent, 'off: a #651-only process and this one pick the same next waiter');
  assert.equal(gate(agree).line[0].agent, 'agree-focused', 'off: both pick by arrival');
  setQueueOrder(agree, { reviewsFirst: true });
  // Each waiter re-marks itself on its next poll, so a setting change reaches every ranking.
  for (let tries = 0; rows().some(({ classed }) => classed !== 1); tries += 1) {
    assert.ok(tries < 250, 'waiters re-mark themselves after the setting turns on');
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
  assert.equal(next651(rows()), gate(agree).line[0].agent, 'on: a #651-only process and this one pick the same next waiter');
  assert.equal(gate(agree).line[0].agent, 'agree-review', 'on: both pick by class');
  await release(agreeHolders[0]);
  assert.equal((await acquired(agreeReview)).acquired, 'agree-review');
  await release(agreeHolders[1]);
  assert.equal((await acquired(agreeFocused)).acquired, 'agree-focused');
  await release(agreeReview);
  await release(agreeFocused);

  // An unusable value is refused by name, with the fix.
  setQueueOrder(aging, { reviewsFirst: 'yes' });
  const badFlag = settingsCli(aging, '--json');
  assert.equal(badFlag.status, 1, 'a non-boolean reviewsFirst is refused');
  assert.equal(JSON.parse(badFlag.stdout).error.code, 'BAD_MACHINE_SETTINGS');
  assert.match(JSON.parse(badFlag.stdout).error.message, /gate\.queue\.reviewsFirst .* must be true or false/u);
  setQueueOrder(aging, { reviewsFirst: true, agingMinutes: 0 });
  const badAging = settingsCli(aging, '--json');
  assert.equal(badAging.status, 1, 'agingMinutes 0 is refused');
  assert.match(JSON.parse(badAging.stdout).error.message, /gate\.queue\.agingMinutes .* must be a positive whole number/u);
});

test('[Q1,Q2] a waiting landing keeps a current holder from taking the second slot [Q1,Q2]', async () => {
  const box = fixture();
  const firstHolder = worker(box, { capacity: 2, agent: 'same-run' });
  const secondHolder = worker(box, { capacity: 2, agent: 'other-run' });
  assert.equal((await acquired(firstHolder)).acquired, 'same-run');
  assert.equal((await acquired(secondHolder)).acquired, 'other-run');
  const landing = worker(box, { capacity: 2, agent: 'landing', landing: true });
  assert.equal((await event(landing)).waiting, 1);
  const secondSlot = worker(box, { capacity: 2, agent: 'same-run' });
  assert.equal((await event(secondSlot)).waiting, 2);
  assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [['landing', true], ['same-run', false]]);

  await release(secondHolder);
  assert.equal((await event(landing)).acquired, 'landing');
  await assert.rejects(event(secondSlot, 250), /worker timed out/u, 'the holder cannot take its second slot ahead of a waiting landing'); // budget: declared negative observation window while an explicitly held landing blocks this waiter.
  await release(landing);
  assert.equal((await event(secondSlot)).acquired, 'same-run');
  await release(secondSlot);
  await release(firstHolder);
});

test('[Q1,Q2] a holder cannot queue a landing second slot ahead of another landing [Q1,Q2]', async () => {
  const box = fixture();
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  let first;
  let second;
  let other;
  let landing;
  let extraLease;
  let extraPromise;
  try {
    first = await takeResource({ name: 'gate', capacity: 2, root: box.first, agent: 'same-run' });
    other = worker(box, { capacity: 2, agent: 'other-run' });
    assert.equal((await acquired(other)).acquired, 'other-run');
    extraPromise = takeResource({ name: 'gate', capacity: 2, root: box.second, agent: 'second-label', landing: true })
      .then((lease) => { extraLease = lease; return lease; });
    await waitUntil(() => privateList(box)[0].line.some(({ agent, landing: isLanding }) => agent === 'second-label' && isLanding), 'the same process second slot to queue');

    landing = worker(box, { capacity: 2, agent: 'next-landing', landing: true });
    assert.equal((await event(landing)).waiting, 1, 'the later landing is the first eligible landing');
    assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [
      ['second-label', true], ['next-landing', true],
    ]);

    await release(other);
    other = null;
    assert.equal((await event(landing)).acquired, 'next-landing', 'a current holder cannot take a second slot ahead of a different landing run');
    const holderAgents = privateList(box)[0].holders.map(({ agent }) => agent).sort();
    assert.deepEqual(holderAgents, ['next-landing', 'same-run']);
    await release(landing);
    landing = null;
    second = await extraPromise;
    assert.deepEqual(privateList(box)[0].holders.map(({ agent }) => agent), ['same-run', 'second-label']);
  } finally {
    if (other && !other.exitResult) await release(other);
    if (landing && !landing.exitResult) {
      first?.release();
      extraLease?.release();
      try { await acquired(landing); } catch { /* Preserve the assertion that led to cleanup. */ }
      if (!landing.exitResult) await release(landing);
    }
    first?.release();
    second?.release();
    extraLease?.release();
    if (extraPromise && !extraLease) {
      await Promise.race([extraPromise.then((lease) => lease.release()), delay(500)]);
    }
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

/** A capacity-three queue must not grant an empty slot to holders queued for their own second slot. */
test('[Q1,Q2] landing holders leave an empty slot for the next eligible landing [Q1,Q2]', async () => {
  const box = fixture();
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  let firstA;
  let secondA;
  let holderB;
  let holderC;
  let secondAPromise;
  let secondAAcquired = false;
  try {
    firstA = await takeResource({ name: 'gate', capacity: 3, root: box.first, agent: 'holder-a' });
    holderB = worker(box, { capacity: 3, agent: 'holder-b' });
    holderC = worker(box, { capacity: 3, agent: 'holder-c' });
    assert.equal((await acquired(holderB)).acquired, 'holder-b');
    assert.equal((await acquired(holderC)).acquired, 'holder-c');

    secondAPromise = takeResource({ name: 'gate', capacity: 3, root: box.first, agent: 'holder-a', landing: true })
      .then((lease) => { secondAAcquired = true; secondA = lease; return lease; });
    await waitUntil(() => privateList(box)[0].line.some(({ agent, landing }) => agent === 'holder-a' && landing), 'holder A second landing to queue');
    holderB.stdin.write('second\n');
    await waitUntil(() => privateList(box)[0].line.filter(({ landing }) => landing).length === 2, 'holder B second landing to join');

    await release(holderC);
    holderC = null;
    await delay(300);
    assert.deepEqual(privateList(box)[0].holders.map(({ agent }) => agent).sort(), ['holder-a', 'holder-b'], 'neither holder takes the free third slot while the other holder landing waits');
    assert.equal(secondAAcquired, false, 'A second slot remains queued');
    assert.deepEqual(holderB.pendingLines.filter((line) => line.includes('secondAcquired')), [], 'B second slot remains queued');

    firstA.release();
    firstA = null;
    await secondAPromise;
    assert.ok(secondAAcquired, 'releasing A first makes its landing the next eligible landing');
    assert.equal((await event(holderB)).secondAcquired, 'holder-b', 'B can finish after A no longer waits');
    holderB.stdin.end('release\n');
    assert.equal((await holderB.finished).code, 0, holderB.errors);
    holderB.lines.close();
    holderB = null;
    secondA.release();
    secondA = null;
  } finally {
    for (const child of [holderB, holderC]) if (child && !child.exitResult) child.kill('SIGKILL');
    await Promise.all([holderB, holderC].filter(Boolean).map((child) => child.finished));
    for (const child of [holderB, holderC]) child?.lines.close();
    firstA?.release();
    secondA?.release();
    privateList(box); // Purge any dead child holder/waiter rows before dropping the private database.
    if (secondAPromise && !secondA) {
      await secondAPromise;
    }
    secondA?.release();
    privateList(box);
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

// Each process and memory case below also owns a distinct pool; no asynchronous parent environment override is shared.
describe('isolated resource process and memory scenarios [C7,Q1,Q2,Q3]', { concurrency: 4 }, () => {
test('[Q1,Q2] landing priority preserves tickets while an older resource database migrates [Q1,Q2]', async () => {
  const box = fixture();
  oldSchema(box);
  const oldSince = new Date().toISOString();
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run('gate', 1);
    db.prepare('INSERT INTO holder(token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('old-holder', 'gate', process.pid, 'old-holder', realpathSync(box.first), oldSince, Date.now());
    for (const [ticket, agent] of [[4, 'old-first'], [9, 'old-second']]) {
      db.prepare('INSERT INTO waiter(ticket, token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ticket, `old-${agent}`, 'gate', process.pid, agent, realpathSync(box.first), oldSince, Date.now());
    }
  } finally { db.close(); }

  let retainedLine;
  assert.doesNotThrow(() => { retainedLine = privateList(box)[0].line; }, 'the previous queue schema opens without losing its waiting runs');
  assert.deepEqual(retainedLine.map(({ agent, landing }) => [agent, landing]), [['old-first', false], ['old-second', false]]);
  const migrated = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    assert.deepEqual(migrated.prepare('SELECT ticket, landing FROM waiter ORDER BY ticket').all().map(({ ticket, landing }) => ({ ticket, landing })), [
      { ticket: 4, landing: 0 }, { ticket: 9, landing: 0 },
    ]);
  } finally { migrated.close(); }

  const landing = worker(box, { agent: 'new-landing', landing: true });
  assert.equal((await event(landing)).waiting, 1);
  assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [
    ['new-landing', true], ['old-first', false], ['old-second', false],
  ]);
  const cleanup = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    cleanup.prepare('DELETE FROM waiter WHERE token IN (?, ?)').run('old-old-first', 'old-old-second');
    cleanup.prepare('DELETE FROM holder WHERE token = ?').run('old-holder');
  } finally { cleanup.close(); }
  assert.equal((await event(landing)).acquired, 'new-landing');
  await release(landing);
});

test('[Q1,Q2] capacity two admits two holders and serves the next waiter', async () => {
  const box = fixture();
  const first = worker(box, { name: 'two-slots', capacity: 2, agent: 'first-holder' });
  const second = worker(box, { name: 'two-slots', capacity: 2, agent: 'second-holder' });
  assert.equal((await acquired(first)).acquired, 'first-holder');
  assert.equal((await acquired(second)).acquired, 'second-holder');
  const next = worker(box, { name: 'two-slots', capacity: 2, agent: 'next-waiter' });
  assert.equal((await event(next)).waiting, 1);
  await release(first);
  assert.equal((await event(next)).acquired, 'next-waiter');
  await release(second);
  await release(next);
});

test('[Q2,Q3] a stopped head waiter keeps its place ahead of the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const first = worker(box, { agent: 'stopped-first' });
  assert.equal((await event(first)).waiting, 1);
  first.kill('SIGSTOP');
  const second = worker(box, { agent: 'second' });
  assert.equal((await event(second)).waiting, 2);
  await release(holder);
  await assert.rejects(event(second, 800), /worker timed out/u, 'the second waiter cannot jump the stopped head'); // budget: declared negative observation window while the stopped queue head blocks this waiter.
  first.kill('SIGCONT');
  assert.equal((await event(first)).acquired, 'stopped-first');
  await release(first);
  assert.equal((await event(second)).acquired, 'second');
  await release(second);
});

test('[Q2,Q3] an evicted live waiter rejoins the FIFO line after it resumes [Q2,Q3]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiter = worker(box, { agent: 'resumed-waiter' });
  assert.equal((await event(waiter)).waiting, 1);
  waiter.kill('SIGSTOP');
  staleIdentity(box, 'waiter', 'resumed-waiter');
  assert.deepEqual(privateList(box)[0].line, []);
  waiter.kill('SIGCONT');
  const rejoined = await event(waiter);
  assert.equal(rejoined.rejoined, true);
  assert.equal(rejoined.waiting, 1);
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'resumed-waiter');
  await release(waiter);
});

test('[Q3] a live stalled holder keeps its place beyond the lease timeout', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'stalled-holder', stallMs: 22_000, env: { TZ: 'UTC' } });
  assert.equal((await event(holder)).acquired, 'stalled-holder');
  const waiter = worker(box, { agent: 'queued-behind-live-holder', env: { TZ: 'Pacific/Honolulu', PATH: '/usr/bin' } });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'a live OS process must not be evicted when its heartbeat pauses'); // budget: declared 22000ms holder stall; observe it still held at 20500ms.
  assert.equal((await event(holder, 5_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'queued-behind-live-holder');
  await release(waiter);
});

test('[Q3] concurrent openers serialize migration of a prior resource database', async () => {
  const box = fixture();
  oldSchema(box);
  const workers = Array.from({ length: 8 }, (_, index) => worker(box, { name: 'legacy', capacity: 8, agent: `migrator-${index}` }));
  const grants = await Promise.all(workers.map((child) => acquired(child)));
  assert.deepEqual(grants.map(({ acquired: agent }) => agent).sort(), workers.map((_, index) => `migrator-${index}`).sort());
  await Promise.all(workers.map(release));
});

test('[Q3] a held lease records its OS process start identity', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'identity-recorded' });
  assert.equal((await acquired(holder)).acquired, 'identity-recorded');
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const row = db.prepare('SELECT started FROM holder WHERE agent = ?').get('identity-recorded');
    assert.ok(row?.started, 'a readable process identity is stored with its lease');
  } finally { db.close(); }
  await release(holder);
});

test('[Q3] process identity lookup ignores a misleading ps on PATH', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'path-spoof-holder' });
  assert.equal((await acquired(holder)).acquired, 'path-spoof-holder');
  expireHeartbeat(box, 'holder', 'path-spoof-holder');
  const fakeBin = join(box.dir, 'fake-bin');
  mkdirSync(fakeBin);
  const fakePs = join(fakeBin, 'ps');
  writeFileSync(fakePs, '#!/bin/sh\nprintf "Mon Jan 1 00:00:00 2001 S\\n"\n');
  chmodSync(fakePs, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    assert.equal(privateList(box)[0].holders[0]?.agent, 'path-spoof-holder', 'the stable absolute ps result keeps the lease');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await release(holder);
});

test('[Q3] an unreadable process identity keeps a live holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-live-holder', stallMs: 27_000 });
  assert.equal((await acquired(holder)).acquired, 'sandbox-live-holder');
  const waiter = worker(box, { agent: 'sandbox-live-waiter', sandboxProcessInfo: true });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'denied process-info access is not proof that a live PID died'); // budget: declared 22000ms holder stall with denied process-info access; observe at 20500ms.
  assert.equal((await event(holder, 8_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await acquired(waiter)).acquired, 'sandbox-live-waiter');
  await release(waiter);
});

test('[Q3] an unreadable process identity still releases a dead holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-dead-holder' });
  assert.equal((await acquired(holder)).acquired, 'sandbox-dead-holder');
  holder.kill('SIGKILL');
  const { signal } = await holder.finished;
  holder.lines.close();
  assert.equal(signal, 'SIGKILL');
  const waiter = worker(box, { agent: 'sandbox-dead-waiter', sandboxProcessInfo: true });
  assert.equal((await acquired(waiter)).acquired, 'sandbox-dead-waiter');
  await release(waiter);
});

test('[Q3] cached live identities expire so an actual zombie holder is released', { skip: !PERL_FORK }, async () => {
  const box = fixture();
  privateList(box);
  const script = 'my $pid = fork(); die "fork failed" unless defined $pid; if ($pid == 0) { select undef, undef, undef, 1.2; exit 0; } print "$pid\\n"; $| = 1; select undef, undef, undef, 30; waitpid($pid, 0);';
  const reaper = spawn('/usr/bin/perl', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: reaper.stdout });
  try {
    const pidText = await new Promise((resolveLine, reject) => {
      lines.once('line', resolveLine);
      reaper.once('error', reject);
      reaper.once('exit', (code) => reject(new Error(`zombie parent exited early: ${code}`)));
    });
    const pid = Number(pidText);
    assert.ok(Number.isInteger(pid) && pid > 0, `Perl reports its child PID: ${pidText}`);
    insertExpiredHolder(box, { name: 'zombie-cache', pid, agent: 'zombie-holder' });
    const cached = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.equal(cached.holders[0]?.agent, 'zombie-holder', 'the live child with an empty stored identity is kept');
    const cacheAt = Date.now();
    await waitForProcessState(pid, 'Z');
    await delay(Math.max(0, cacheAt + 3_200 - Date.now()));
    const afterExpiry = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.deepEqual(afterExpiry.holders, [], 'the refreshed process state identifies and releases the zombie');
  } finally {
    lines.close();
    if (reaper.exitCode === null && reaper.signalCode === null) {
      reaper.kill('SIGKILL');
      await once(reaper, 'exit');
    }
  }
});

test('[Q3] renew refuses after an OS start-identity mismatch evicts the holder', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'evicted-holder' });
  assert.equal((await event(holder)).acquired, 'evicted-holder');
  staleIdentity(box, 'holder', 'evicted-holder');
  assert.deepEqual(privateList(box)[0].holders, []);
  holder.stdin.write('renew\n');
  assert.equal((await event(holder)).renewError, 'RESOURCE_LEASE_LOST');
  holder.stdin.end('release\n');
  assert.equal((await holder.finished).code, 0, holder.errors);
});

test('[Q3] SIGKILL of a holder frees its lease for the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'doomed-holder' });
  assert.equal((await event(holder)).acquired, 'doomed-holder');
  const next = worker(box, { agent: 'successor' });
  const waiting = await event(next);
  assert.equal(waiting.waiting, 1);
  holder.kill('SIGKILL');
  await holder.finished;
  assert.equal((await event(next)).acquired, 'successor');
  await release(next);
});

test('[Q2,Q3] a SIGKILLed waiter is skipped while the next live waiter advances', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const dead = worker(box, { agent: 'dead-waiter' });
  assert.equal((await event(dead)).waiting, 1);
  const live = worker(box, { agent: 'live-waiter' });
  assert.equal((await event(live)).waiting, 2);
  dead.kill('SIGKILL');
  await dead.finished;
  await release(holder);
  assert.equal((await event(live)).acquired, 'live-waiter');
  await release(live);
});

const CLI_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../src/cli.js')).href;

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

test('the pool holds work while the machine is out of memory and names the biggest process [C7]', async () => {
  const box = fixture();
  const reading = join(box.dir, 'memory.json');
  writeMemoryReading(reading, { availableMB: 100, fullAvg10: 99, someAvg10: 99 });
  // Off by default: with no floor set, even a critical machine is never read or held.
  const unset = memoryWorker(box, 'no-floor-run', reading);
  const unsetStart = await event(unset);
  assert.equal(unsetStart.acquired, 'no-floor-run', `with no floor set the pool admits by slots alone: ${JSON.stringify(unsetStart)}`);
  assert.equal(unsetStart.reads, 0, 'with no floor set the pool reads no memory');
  assert.equal(unsetStart.memory, undefined, 'with no floor set nothing is held or reported');
  await release(unset);

  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: 512 } })}\n`);
  const biggest = 'biggest: pid 4242 python3 24.0 GB in /work/journal-reader; pid 4343 python3.12 23.0 GB in /work/other-reader; pid 5151 node 2.0 GB in /work/pullboard';
  writeMemoryReading(reading, { availableMB: 8192, fullAvg10: 42, someAvg10: 80 });
  const run = memoryWorker(box, 'held-run', reading);

  const critical = await event(run);
  assert.equal(critical.acquired, undefined, 'a critical reading must not admit the run');
  assert.equal(critical.waiting, 1, 'the held run keeps its place at the head of the line');
  assert.equal(critical.memory?.held, true, `the run is held for memory: ${JSON.stringify(critical)}`);
  assert.equal(critical.memory.line,
    `memory: holding local gate runs because pressure is critical: pressure critical, 8.0 GB free of 36.0 GB (floor 512 MB); ${biggest}`,
    'one line says why and names the three biggest processes with pid, size and working directory');
  assert.doesNotMatch(critical.memory.line, /\n/u, 'the hold is one line');
  const gate = privateList(box).find(({ name }) => name === 'gate');
  assert.equal(gate.holders.length, 0, 'no run holds a slot while memory is critical, though both slots are free');
  assert.deepEqual(gate.line.map(({ agent }) => agent), ['held-run'], 'the held run waits in the queue');
  await delay(300);
  assert.ok(!run.pendingLines.some((line) => JSON.parse(line).acquired), 'the run stays held while the reading stays critical');

  writeMemoryReading(reading, { availableMB: 400 });
  const low = await event(run);
  assert.equal(low.memory?.held, true, `free memory under the settings floor still holds: ${JSON.stringify(low)}`);
  assert.equal(low.memory.line,
    `memory: holding local gate runs because free memory is under the floor: pressure normal, 400 MB free of 36.0 GB (floor 512 MB); ${biggest}`,
    'the floor comes from gate.memoryFloorMB in pullboard settings');

  writeMemoryReading(reading, { availableMB: 8192 });
  const recovered = await acquired(run).catch((error) => assert.fail(`the held run is admitted once memory recovers: ${error.message.split('\n')[0]}`));
  assert.equal(recovered.acquired, 'held-run', 'the held run is admitted once memory recovers');
  await release(run);
});

test('the memory hold is off until a floor is set, an unread machine warns once, and resources prints the memory line [C7]', async () => {
  const { gateWaitReporter } = await import('../index.js');
  const said = [];
  const report = gateWaitReporter({ say: (line) => said.push(line) });
  report({ holders: [], position: 1, memory: { checked: true, held: true, line: 'memory: holding the gate queue because pressure is critical: first' } });
  report({ holders: [], position: 1, memory: { checked: true, held: true, line: 'memory: holding the gate queue because pressure is critical: sizes moved' } });
  report({ holders: [], position: 1 });
  assert.deepEqual(said, ['memory: holding the gate queue because pressure is critical: first', 'gate waiting: 0 running; place 1'],
    'a held run prints its line once per hold, then the ordinary queue line');
  const warned = [];
  const warn = gateWaitReporter({ say: (line) => warned.push(line) });
  const unchecked = { checked: false, held: false, line: 'memory: not checked on win32', warning: 'memory: not checked on win32' };
  warn({ holders: [], line: [], position: 0, memory: unchecked });
  warn({ holders: [], line: [], position: 0, memory: unchecked });
  assert.deepEqual(warned, ['memory: not checked on win32'], 'an unread machine prints one warning');

  const box = fixture();
  const critical = join(box.dir, 'critical.json');
  writeMemoryReading(critical, { availableMB: 100, fullAvg10: 99 });
  const unset = memoryWorker(box, 'unset-run', critical);
  const unsetStart = await event(unset);
  assert.equal(unsetStart.acquired, 'unset-run', `with gate.memoryFloorMB absent the pool admits by slots alone, as before: ${JSON.stringify(unsetStart)}`);
  await release(unset);
  const defaults = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(JSON.parse(defaults.stdout).memoryFloorMB, null, 'pullboard settings reports the hold as off when the floor is absent');
  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: -1 } })}\n`);
  const refused = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, 'BAD_MACHINE_SETTINGS');
  assert.match(JSON.parse(refused.stdout).error.message, /gate\.memoryFloorMB/u);
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: 1024 } })}\n`);
  const set = runFixtureChild(process.execPath, [BIN, 'settings'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^gate\.memoryFloorMB: 1024$/mu, 'pullboard settings shows the floor once it is set');

  for (const source of ['win32', 'broken']) {
    const file = join(box.dir, `${source}.json`);
    writeMemoryReading(file, { availableMB: 100, fullAvg10: 99, broken: true });
    const run = memoryWorker(box, `${source}-run`, source === 'win32' ? 'win32' : file);
    const first = await event(run);
    assert.equal(first.memory?.checked, false, `${source}: the run hears that memory is not checked: ${JSON.stringify(first)}`);
    assert.match(first.memory.warning, /^memory: not checked on (win32|linux) \(.+\); the gate pool admits by slots alone$/u);
    assert.equal((await event(run)).acquired, `${source}-run`, `${source}: an unread machine admits as today, after exactly one warning`);
    await release(run);
  }

  checkProject(box);
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: {} })}\n`);
  const off = runFixtureChild(process.execPath, [BIN, 'resources', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).memory, null, 'with no floor set pullboard resources reads no memory');
  const offHuman = runFixtureChild(process.execPath, [BIN, 'resources'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(offHuman.status, 0, offHuman.stderr);
  assert.doesNotMatch(offHuman.stdout, /^memory: /mu, 'with no floor set pullboard resources prints no memory line');
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: 1024 } })}\n`);
  const human = runFixtureChild(process.execPath, [BIN, 'resources'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(human.status, 0, human.stderr);
  const printed = human.stdout.split('\n').filter((line) => line.startsWith('memory: '));
  assert.equal(printed.length, 1, `pullboard resources prints one machine memory line: ${human.stdout}`);
  assert.match(printed[0], /^memory: (admitting: |holding the gate queue because |not checked on )/u);
  const json = runFixtureChild(process.execPath, [BIN, 'resources', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).memory.line, /^memory: /u, 'the JSON result carries the same machine line');
});

});

test('[Q4] machine capacity decreases atomically refuse an occupied or queued resource', async () => {
  const box = fixture();
  const oldHome = process.env.PULLBOARD_HOME;
  const oldMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  const holder = worker(box, { capacity: 2, agent: 'capacity-holder' });
  let secondHolder;
  let waiter;
  try {
    assert.equal((await event(holder)).acquired, 'capacity-holder');
    secondHolder = worker(box, { capacity: 2, agent: 'capacity-second-holder' });
    assert.equal((await event(secondHolder)).acquired, 'capacity-second-holder');
    waiter = worker(box, { capacity: 2, agent: 'capacity-waiter' });
    assert.equal((await event(waiter)).waiting, 1);
    let persisted = false;
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 1, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    assert.equal(persisted, false, 'settings remain unchanged while a holder and waiter exist');
    await release(holder);
    assert.equal((await event(waiter)).acquired, 'capacity-waiter');
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 1, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    await release(waiter);
    await release(secondHolder);
    const changed = setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } });
    assert.deepEqual(changed, { name: 'gate', capacity: 3 });
    assert.equal(persisted, true, 'settings persist under the same queue lock as the capacity');
    assert.equal(privateList(box)[0].capacity, 3);
    const lease = await takeResource({ name: 'gate', capacity: 3, capacityProvider: () => 4, allowIdleCapacityUpdate: true, root: box.first, agent: 'fresh-capacity' });
    assert.equal(privateList(box)[0].capacity, 4, 'a queued gate reads the latest setting after taking the SQLite lock');
    lease.release();
  } finally {
    if (!holder.exitResult) await release(holder);
    if (secondHolder && !secondHolder.exitResult) await release(secondHolder);
    if (waiter && !waiter.exitResult) await release(waiter);
    if (oldHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = oldHome;
    if (oldMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = oldMachineHome;
  }
});

test('[Q1] machine scope is shared, repo scope stays local, and board scope names relay requirement', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'repo-a', root: box.first });
  assert.equal((await event(holder)).acquired, 'repo-a');
  const otherRepo = worker(box, { agent: 'repo-b', root: box.second });
  assert.equal((await event(otherRepo)).waiting, 1);
  await release(holder);
  assert.equal((await event(otherRepo)).acquired, 'repo-b');
  await release(otherRepo);
  const localA = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-a', root: box.first });
  const localB = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-b', root: box.second });
  assert.equal((await event(localA)).acquired, 'repo-a');
  assert.equal((await event(localB)).acquired, 'repo-b');
  await release(localA);
  await release(localB);
  const refused = spawnSync(process.execPath, ['--input-type=module', '-e', `import {takeResource} from ${JSON.stringify(MODULE)}; await takeResource({name:'x',capacity:1,scope:'board'});`], { env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /BOARD_SCOPE_UNAVAILABLE.*relay/i);
});

test('[Q4] a red gate releases its lease before the same process starts another gate', async () => {
  const box = fixture();
  const command = join(box.dir, 'red-then-green.cjs');
  const counter = join(box.dir, 'gate-count');
  const eventsFile = join(box.dir, 'gate-runs.log');
  writeFileSync(command, [
    "const fs = require('node:fs');",
    'const [counter, events] = process.argv.slice(2);',
    'const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0);',
    'fs.writeFileSync(counter, String(count + 1));',
    "fs.appendFileSync(events, 'start\\nend\\n');",
    'process.exit(count === 0 ? 7 : 0);',
  ].join('\n'));
  const gateCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(command)} ${JSON.stringify(counter)} ${JSON.stringify(eventsFile)}`;
  const worker = redGateReleaseSource();
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, gateCommand], {
    cwd: box.first, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the red gate kept its lease and blocked the same process')), 5_000); }), // budget: hang ceiling for the same process to reacquire its released gate slot.
    ]);
    assert.equal(result.code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { firstGreen: false, secondGreen: true });
    assert.deepEqual(readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/u), ['start', 'end', 'start', 'end']);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await closed;
  }
});


/** A write lock on the slot database delays a queued run; only a lock past the deadline stops it, as never ran [C7]. */
test('a gate-slot waiter retries a locked slot database [C7]', async () => {
  const box = fixture();
  mkdirSync(box.home, { recursive: true });
  const released = join(box.dir, 'lock-released');
  // The waiter's test passes only if the lock was already released when it ran.
  writeFileSync(join(box.first, 'ran.test.js'), `import assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('the waiter ran', () => assert.ok(existsSync(${JSON.stringify(released)})));\n`);
  const env = { ...box.env, PULLBOARD_SLOT_DB_LOCK_MS: '6000' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  /** Hold a write lock on the machine slot database from another process for `ms`; wrapped so awaiting it waits only for the lock. */
  const holdLock = async (ms) => {
    const marker = join(box.dir, `locked-${ms}`);
    const locker = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { writeFileSync } from 'node:fs';
      const [file, marker, ms, released] = process.argv.slice(1);
      const db = new DatabaseSync(file);
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE IF NOT EXISTS lock_probe (x)');
      writeFileSync(marker, 'locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
      db.exec('COMMIT');
      writeFileSync(released, 'released');`, join(box.home, 'resources.sqlite'), marker, String(ms), released], { env });
    await waitForMarker(marker);
    return { done: locker, pid: locker.child.pid, stop: () => locker.child.kill('SIGKILL') };
  };
  /** Run one named test file through the real runner, which waits for a machine gate slot. */
  const runWaiter = () => awaitNestedRun(runFixtureChildAsync(process.execPath, [TEST_RUNNER, 'ran.test.js'], { cwd: box.first, env }));

  const shortLock = await holdLock(3_000);
  const kept = await runWaiter();
  assert.equal((await shortLock.done).status, 0, 'the 3 s lock was taken and released');
  assert.equal(kept.status, 0, `${kept.context}\n${kept.stdout}`);
  assert.match(kept.stdout, /ok \d+ - the waiter ran/u);
  assert.match(kept.stdout, /^# fail 0$/mu);

  rmSync(released);
  const longLock = await holdLock(60_000);
  try {
    const stopped = await runWaiter();
    assert.equal(stopped.status, 75, stopped.context);
    assert.match(stopped.stderr, /never ran/u);
    assert.match(stopped.stderr, /not a test failure/u);
    assert.match(stopped.stderr, new RegExp(`pid ${longLock.pid}\\b`, 'u'), 'names the process holding the lock');
    assert.doesNotMatch(stopped.stdout, /the waiter ran/u);
  } finally { longLock.stop(); await longLock.done; }
});

const capacityCases = capacityChangeCases({ fixture, worker, event, acquired, release, privateList, poolWorker, POOL_MODULE_WORKER, configureBrowserSlots });

/** Existing queued processes observe a raised limit without restarting their holders [Q1,Q2,Q4]. */
test("raising a busy resource's capacity admits waiters at once [Q1,Q2,Q4]", capacityCases.raising);

/** A refused decrease names the live holders and leaves their leases and settings intact [Q1,Q3,Q4]. */
test("lowering capacity never stops a running holder [Q1,Q3,Q4]", capacityCases.lowering);

/** Browser capacity can grow under the same live gate lease without exceeding either limit [Q1,Q2,Q4]. */
test("raising busy browser capacity admits only the new browser slots [Q1,Q2,Q4]", capacityCases.browser);

test('a verification with no frozen check never enters the test queue [C7,V4]', async t => {
  const { project, box, item, reviewer } = verificationProject(t);
  const holder = worker(box, { agent: 'empty-check-holder' });
  await acquired(holder);
  let completed;
  const verifying = runFixtureChildAsync(process.execPath, [BIN, 'verify', String(item), 'accept', '--note', 'The private bar holds.', '--json'],
    { cwd: reviewer, env: project.env }).then(result => { completed = result; return result; });
  try {
    await waitUntil(() => completed || privateList(box).find(row => row.name === 'gate')?.line.some(row => row.item === String(item)),
      'the verification to finish or enter its private queue');
    const gate = privateList(box).find(row => row.name === 'gate');
    assert.equal(gate.line.some(row => row.item === String(item)), false, 'an empty frozen check must not add a native waiter');
    assert.ok(gate.holders.some(row => row.agent === 'empty-check-holder'), 'the unrelated holder remains occupied throughout verification');
    assert.ok(completed, 'the verifier completed without waiting for that holder');
    assert.equal(completed.status, 0, completed.failure ?? completed.stderr);
    assert.equal(JSON.parse(completed.stdout).check, 'none');
    assert.equal(privateList(box).find(row => row.name === 'browser')?.line.some(row => row.item === String(item)) ?? false, false,
      'an empty frozen check adds no browser waiter either');
  } finally { await release(holder); await verifying; }
});

test('a verification with a frozen check still waits for its slot [C7,V4]', async t => {
  const { project, box, item, reviewer, marker } = verificationProject(t, { checked: true });
  rmSync(marker, { force: true });
  const holder = worker(box, { agent: 'real-check-holder' });
  await acquired(holder);
  let completed;
  const verifying = runFixtureChildAsync(process.execPath, [BIN, 'verify', String(item), 'accept', '--note', 'The exact frozen command passed.', '--json'],
    { cwd: reviewer, env: project.env }).then(result => { completed = result; return result; });
  try {
    await waitUntil(() => completed || privateList(box).find(row => row.name === 'gate')?.line.some(row => row.item === String(item)),
      'the nonempty frozen check to enter its private queue');
    assert.equal(privateList(box).find(row => row.name === 'gate').line.some(row => row.item === String(item)), true,
      'a real frozen command keeps the normal native admission boundary');
    assert.equal(completed, undefined, 'the check cannot finish while its slot remains occupied');
    assert.equal(existsSync(marker), false, 'the frozen command has not run early');
  } finally { await release(holder); await verifying; }
  assert.equal(completed.status, 0, completed.failure ?? completed.stderr);
  assert.equal(JSON.parse(completed.stdout).check, 'green');
  assert.equal(readFileSync(marker, 'utf8'), 'check-ran', 'the unchanged frozen command ran after admission');
});

test('a stopped view leaves no view-port row [C7]', async () => {
  const box = fixture();
  const name = (port) => `view-port-${port}`;
  const names = () => resourceNames(box.home);
  const leases = [];
  let dead, holder, waiter, view;
  try {
    privateList(box);
    const baseline = names().filter((entry) => entry.startsWith('view-port-')).length;
    view = await openPrivateScopedView(box);
    const stopped = await privateTake(box, { name: name(view.port), capacity: 1, agent: 'view-port-stopped' });
    leases.push(stopped);
    assert.ok(names().includes(stopped.name), 'the running view has a resource row for its bound port');
    await view.close(); view = null;
    stopped.release(); leases.pop();
    assert.equal(names().filter((entry) => entry.startsWith('view-port-')).length, baseline,
      'stopping the view and releasing its final lease returns to the prior view-port count');

    dead = worker(box, { name: name(4892), agent: 'view-port-dead' });
    await acquired(dead);
    dead.kill('SIGKILL'); await dead.finished; dead.lines.close();
    assert.ok(!privateList(box).some(({ name: entry }) => entry === name(4892)), 'the next resource read sweeps a dead view and its empty port row');

    holder = worker(box, { name: name(4893), agent: 'view-port-holder' });
    await acquired(holder);
    waiter = worker(box, { name: name(4893), agent: 'view-port-waiter' });
    await waitUntil(() => privateList(box).find(({ name: entry }) => entry === name(4893))?.line.some(({ agent }) => agent === 'view-port-waiter'),
      'a same-port view waits behind the live holder');
    assert.ok(names().includes(name(4893)), 'a live holder and queued view retain their port row');
    await release(holder); holder = null;
    await acquired(waiter);
    assert.ok(names().includes(name(4893)), 'the waiting view keeps the row when it acquires the released port');
    await release(waiter); waiter = null;
    assert.ok(!names().includes(name(4893)), 'releasing the final view removes its port row');

    for (const resource of ['gate', 'ordinary', 'View-Port-4894']) {
      const lease = await privateTake(box, { name: resource, capacity: 1, agent: `${resource}-fixture` });
      leases.push(lease); lease.release(); leases.pop();
    }
    const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
    try { db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run('runner:fixture-host', 2); }
    finally { db.close(); }
    privateList(box);
    const kept = names();
    assert.ok(kept.includes('gate') && kept.includes('ordinary') && kept.includes('View-Port-4894') && kept.includes('runner:fixture-host'),
      'empty gate, ordinary, case-distinct view-like, and runner definitions are preserved');
  } finally {
    try {
      for (const lease of leases.reverse()) lease.release();
      if (dead && !dead.exitResult) { dead.kill('SIGKILL'); await dead.finished; dead.lines.close(); }
      for (const child of [holder, waiter]) if (child && !child.exitResult) await release(child);
    } finally { if (view) await view.close(); }
  }
});
