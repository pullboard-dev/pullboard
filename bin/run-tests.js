#!/usr/bin/env node
/**
 * Run the test suite with a private home, no inherited Git identity or config, and a refusing CLI shim.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { after, afterEach, beforeEach } from 'node:test';
import { Worker } from 'node:worker_threads';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';

const runner = fileURLToPath(import.meta.url);
export const DEFAULT_TEST_TIMEOUT_MS = 660_000;

const watchdogSource = `
const { parentPort } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const timers = new Map();
parentPort.on('message', (message) => {
  if (message.type === 'stop') {
    const active = timers.get(message.id);
    if (active) clearTimeout(active.timer);
    timers.delete(message.id);
    return;
  }
  if (message.type !== 'start') return;
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    const elapsedMs = Date.now() - startedAt;
    writeSync(2, 'run-tests: test "' + message.name + '" in ' + message.file +
      ' failed: it ran ' + (elapsedMs / 1000).toFixed(1) + 's, past the ' +
      message.timeoutMs + 'ms per-test timeout\\n');
    try { process.kill(message.pid, 'SIGKILL'); } catch { /* The timed-out test process already exited. */ }
  }, message.timeoutMs);
  timers.set(message.id, { timer });
});
`;

/**
 * Read the per-test timeout and reject malformed overrides before tests start.
 *
 * @param {string | undefined} value
 * @returns {number}
 */
function testTimeoutMs(value = process.env.PULLBOARD_TEST_TIMEOUT_MS) {
  if (value === undefined) return DEFAULT_TEST_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new Error('PULLBOARD_TEST_TIMEOUT_MS must be a positive integer no greater than 2147483647 milliseconds');
  }
  return Number(value);
}

/**
 * Keep an independent watchdog for every active test in this test-file process.
 *
 * @returns {void}
 */
function installTestWatchdog() {
  const timeoutMs = testTimeoutMs();
  const file = process.env.PULLBOARD_TEST_FILE ?? process.argv[1] ?? '<unknown test file>';
  const watchdog = new Worker(watchdogSource, { eval: true });
  watchdog.unref();
  const activeTests = new WeakMap();
  let nextTestId = 0;

  beforeEach((context) => {
    const id = `${process.pid}:${++nextTestId}`;
    const name = String(context.name).replace(/[\r\n\t\u0000-\u001f]/gu, ' ').slice(0, 200);
    activeTests.set(context, id);
    watchdog.postMessage({ type: 'start', id, name, file, timeoutMs, pid: process.pid });
  });

  afterEach((context) => {
    const id = activeTests.get(context);
    if (id !== undefined) watchdog.postMessage({ type: 'stop', id });
  });

  after(async () => {
    await watchdog.terminate();
  });
}

/** Quote a path for the private Git shim without interpreting shell metacharacters. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Build a private environment that makes local tests fail for the same missing Git and CLI setup as CI.
 *
 * @param {string} sandbox
 * @returns {NodeJS.ProcessEnv}
 */
function testEnvironment(sandbox) {
  const home = join(sandbox, 'home');
  const shims = join(sandbox, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(shims, { recursive: true });
  const refusal = join(shims, 'pullboard');
  writeFileSync(refusal, '#!/bin/sh\nprintf "pullboard is not installed; current test: %s\\n" "${PULLBOARD_TEST_FILE:-unknown}" >&2\nexit 1\n');
  chmodSync(refusal, 0o755);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0];
  const git = join(shims, 'git');
  writeFileSync(git, `#!/bin/sh\nexec ${shellWord(realGit)} -c user.useConfigOnly=true "$@"\n`);
  chmodSync(git, 0o755);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  // Model a plain user terminal; person-boundary tests inject agent markers explicitly.
  for (const key of AGENT_SHELL_MARKERS) delete env[key];
  for (const key of SSH_SHELL_MARKERS) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.PULLBOARD_HOME = home;
  env.PULLBOARD_MODEL = 'Test Model';
  env.TMPDIR = sandbox;
  env.TMP = sandbox;
  env.TEMP = sandbox;
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '3';
  env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly';
  env.GIT_CONFIG_VALUE_0 = 'true';
  env.GIT_CONFIG_KEY_1 = 'gc.auto';
  env.GIT_CONFIG_VALUE_1 = '0';
  env.GIT_CONFIG_KEY_2 = 'maintenance.auto';
  env.GIT_CONFIG_VALUE_2 = 'false';
  env.PATH = [shims, process.env.PATH].filter(Boolean).join(delimiter);
  delete env.PULLBOARD_RELAY_TOKEN; // Fixtures must supply their own scoped credentials, never an agent’s live bearer.
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_TEST_FILE;
  return env;
}

/**
 * Start the Node test runner and return its result to the caller for faithful exit handling.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runTests(args, env) {
  const reporter = args.some((argument) => argument === '--test-reporter' || argument.startsWith('--test-reporter='));
  const nodeArgs = [
    '--disable-warning=ExperimentalWarning',
    '--test',
    ...(!reporter ? ['--test-reporter=tap'] : []),
    '--import',
    runner,
    ...args,
  ];
  return spawnSync(process.execPath, nodeArgs, { env, stdio: 'inherit' });
}

/**
 * Launch Node's test runner in a disposable environment and remove it after the run ends.
 *
 * @param {string[]} args
 * @returns {void}
 */
function main(args) {
  try {
    testTimeoutMs();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-test-run-'));
  let signal = null;
  try {
    const result = runTests(args, testEnvironment(sandbox));
    if (result.error) throw result.error;
    signal = result.signal;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  if (signal) process.kill(process.pid, signal);
}

if (process.argv[1] && resolve(process.argv[1]) === runner) {
  main(process.argv.slice(2));
} else if (process.argv[1]) {
  process.env.PULLBOARD_TEST_FILE = process.argv[1];
  installTestWatchdog();
}
