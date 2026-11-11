/** @pullboard-module-loads ** */
// Custom reporters are user-selected: ** covers every committed module, not a finite reporter list.
/** Run the test suite with a private home, no inherited Git identity or config, and a refusing CLI shim. */
import { appendFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { afterEach } from 'node:test';
import { beforeEach } from 'node:test';
import { Worker } from 'node:worker_threads';
import { watchdogSource } from './run-tests-watchdog-source.js';
import { randomUUID } from 'node:crypto';
import { installFileWatchdog } from '../../../drive/light.js';
import { DEFAULT_TEST_FILE_TIMEOUT_MS } from './test/drain.js';
import { testFileTimeoutMs } from './test/drain.js';
import { activeHandleSummary } from './test/drain.js';
import { installTestChildDrain } from './test/drain.js';
import { channel } from 'node:diagnostics_channel';
import { selectedTestResult } from './test/selection.js';
import { isGitWorkTree } from './test/selection.js';
import { trackedDefaultTestFiles } from './test/selection.js';
import { shardArguments } from './test/selection.js';
import { testSelectionPatterns } from './test/selection.js';
import { narrowsSelection } from './test/selection.js';
import { AGENT_SHELL_MARKERS } from '../../../kernel/light.js';
import { SSH_SHELL_MARKERS } from '../../../kernel/light.js';
import { isWorkerProcessIdentityTimeout } from '../../../drive/light.js';
import { workerProcessIdentityQuery } from '../../../drive/light.js';
import { parseWorkerProcessIdentity } from '../../../drive/light.js';
import { foreignNodeOptions } from './test/isolation.js';
import { isolateTestMachine } from './test/isolation.js';
import { TEST_FILE_POOL_ENV } from './test/file/pool.js';
import { longestFirst } from './test/file/pool.js';
import { takeTestFileToken } from './test/file/pool.js';
import { testFilePoolValue } from './test/file/pool.js';
import { optionTakesValue } from './test/file/dispatch.js';
import { knownNodeOption } from './test/file/dispatch.js';
import { COLLECTION_ID_ENV } from '../logic/collection/env.js';
import { beginSuiteTiming } from './run/timing.js';
import { TIMING_RUN_ID_ENV } from './run/timing.js';
import { hasTestFiles as selectedFilesPresent } from './test/selection.js';
import { explicitTestFiles as selectedFiles } from './test/selection.js';
import { formatTestOutcomes } from './test/outcomes.js';
import { removeGitRepositorySelectors } from '../../../git/index.js';
// The front door loads gate.js eagerly, and a plain run must keep the gate lazy [C7,V4].
import { testRunPhaseClock } from './test/run/phases.js';
// Discovery and full-suite delegation happen before the existing per-worker isolation below.
removeGitRepositorySelectors(process.env, text => process.stderr.write(text));
/** Keep selected path parsing on the same native option-arity contract. */
const explicitTestFiles = args => selectedFiles(args, optionTakesValue);
/** Distinguish actual files from option values before admission. */
const hasTestFiles = args => selectedFilesPresent(args, optionTakesValue);
/** The launcher's own path (set by startRunTests): the preload and the self-spawn target, never this file. */
let runner;
/** Loaders for the cells above gate, handed in by the launcher so gate imports nothing upward. */
let services;
let recordRunnerWait = () => {};
const LANDING_RUN_ENV = 'PULLBOARD_LANDING_RUN';
const LANDING_WORKER_STARTS_ENV = 'PULLBOARD_LANDING_WORKER_STARTS';
const LANDING_ATTEMPT_ENV = 'PULLBOARD_LANDING_ATTEMPT';
const LANDING_WAIVERS_ENV = 'PULLBOARD_LANDING_WAIVERS';
// Mirrors packages/landing/src/io/shards.js; this preload stays free of landing until a landing run needs it.
const LANDING_COLLECT_ALL_ENV = 'PULLBOARD_LANDING_COLLECT_ALL';
const LANDING_SHARD_ENV = 'PULLBOARD_LANDING_SHARD';
const LANDING_FILE_TIMES_ENV = 'PULLBOARD_LANDING_FILE_TIMES';
export const DEFAULT_TEST_TIMEOUT_MS = 660_000;
export { DEFAULT_TEST_FILE_TIMEOUT_MS };
// Worker identity startup retries stay below the ordinary per-file ceiling even if ps is unavailable.
const LANDING_WORKER_IDENTITY_TIMEOUT_MS = 12_000;
const LANDING_CHILD_CUSTODY_TIMEOUT_MS = 12_000;
let reportFileTest = () => {};

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
 * @returns {{ pause: () => void, resume: () => void }}
 */
function installTestWatchdog() {
  const timeoutMs = testTimeoutMs();
  const fileTimeoutMs = testFileTimeoutMs();
  const file = process.env.PULLBOARD_TEST_FILE ?? process.argv[1] ?? '<unknown test file>';
  const watchdog = new Worker(watchdogSource, { eval: true });
  watchdog.on('message', (message) => {
    if (message.type !== 'file-diagnostic-request') return;
    watchdog.postMessage({
      type: 'file-diagnostic-update', id: message.id,
      handles: activeHandleSummary(), observedAt: Date.now(),
    });
  });
  // Message listeners ref the worker port; unref only after installing the diagnostic listener.
  watchdog.unref();
  const activeTests = new WeakMap();
  const runningTests = new Set();
  const fileId = `${process.pid}:file`;
  let fileWatchdogArmed = false;
  let nextTestId = 0;

  beforeEach((context) => {
    if (fileWatchdogArmed) {
      watchdog.postMessage({ type: 'stop', id: fileId });
      fileWatchdogArmed = false;
    }
    const id = `${process.pid}:${++nextTestId}`;
    const name = String(context.name).replace(/[\r\n\t\u0000-\u001f]/gu, ' ').slice(0, 200);
    reportFileTest(id, name, timeoutMs);
    activeTests.set(context, id);
    runningTests.add(id);
    watchdog.postMessage({ type: 'start', id, name, file, timeoutMs, pid: process.pid });
  });

  afterEach((context) => {
    // Test-owned after hooks run after afterEach; keep the case watchdog until cleanup ends.
    context.after(() => {
      const id = activeTests.get(context);
      if (id !== undefined) {
        reportFileTest(id, null);
        watchdog.postMessage({ type: 'stop', id });
        runningTests.delete(id);
      }
      if (runningTests.size === 0) armFileExitWatchdog();
    });
  });

  /** Bound cleanup between completed tests, cancelling the ceiling when another test starts. */
  function armFileExitWatchdog() {
    if (fileWatchdogArmed) return;
    fileWatchdogArmed = true;
    watchdog.postMessage({
      type: 'start-file', id: fileId, file,
      timeoutMs: fileTimeoutMs, pid: process.pid, handles: activeHandleSummary(),
    });
  }

  after(armFileExitWatchdog);
  return {
    /** Give the bounded child drain custody of cleanup until it settles. */
    pause() { if (fileWatchdogArmed) { watchdog.postMessage({ type: 'stop', id: fileId }); fileWatchdogArmed = false; } },
    resume: armFileExitWatchdog,
  };
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
function testEnvironment(sandbox, gateMarkers = {}) {
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
  // A test that starts its own run-tests is never a shard of this landing.
  delete env[LANDING_SHARD_ENV];
  delete env[TIMING_RUN_ID_ENV];
  delete env[COLLECTION_ID_ENV];
  env.PULLBOARD_TEST_SANDBOX = sandbox;
  env.HOME = home;
  env.USERPROFILE = home;
  env.PULLBOARD_HOME = home;
  env.PULLBOARD_MODEL = 'Test Model'; env.PULLBOARD_OWN_CLI = '1'; // #2458: tests run the candidate's own CLI.
  env.PULLBOARD_MACHINE_HOME = join(sandbox, 'machine');
  // A test finds its runner by this pid, never by parsing ps text; a nested runner sets its own (#1073).
  env.PULLBOARD_TEST_RUNNER_PID = String(process.pid);
  // #1046: every file of every run takes a token from one machine pool; a nested run keeps its parent's loan.
  env[TEST_FILE_POOL_ENV] = testFilePoolValue(process.env);
  isolateTestMachine(env, sandbox); // #1068: no settings, resources, runners or host markers of the real machine.
  // init and resume start a background view by default; a test opts back in by deleting this.
  env.PULLBOARD_VIEW_BACKGROUND = '0';
  // Likewise the relay checkpoint publishes inside the command; a test of the background publisher opts in (#1014).
  env.PULLBOARD_RELAY_CHECKPOINT_BACKGROUND = '0';
  // And a local-first board's relay sender runs inside each command; a test of the machine's sender opts in (#1013).
  env.PULLBOARD_RELAY_SENDER_BACKGROUND = '0';
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
  delete env[LANDING_WORKER_STARTS_ENV];
  delete env[LANDING_ATTEMPT_ENV];
  // The outer gate decides whether this invocation is fail-fast. Its test workers and
  // any nested runner commands always retain ordinary runner semantics.
  env[LANDING_RUN_ENV] = '0';
  for (const name of [LANDING_COLLECT_ALL_ENV, COLLECTION_ID_ENV, 'PULLBOARD_RELEASE_EXECUTORS']) delete env[name];
  Object.assign(env, gateMarkers);
  env[LANDING_RUN_ENV] = '0';
  return env;
}

/** Load a caller-selected reporter at the CLI boundary; the dispatcher imports only its fixed dependencies. */
async function loadCustomReporter(reporter) {
  return (await import(reporter.startsWith('.') || reporter.startsWith('/')
    ? pathToFileURL(resolve(reporter)).href : reporter)).default;
}

/**
 * Run ordinary mode through admitted files and return its result for faithful exit handling.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{status:number,signal:null}>}
 */
async function runTests(args, env, concurrency) {
  const { nativeFileArguments, reportDispatchedTests, legacyFileMode, legacyNativeFileRun } = await import('./test/file/dispatch.js');
  if (legacyFileMode(args)) return legacyNativeFileRun(args, env, concurrency, { runner, knownNodeOption, optionTakesValue });
  const normalized = nativeFileArguments(args, concurrency, knownNodeOption, optionTakesValue);
  const { options } = await landingTestOptions(normalized.args, env, normalized.concurrency);
  if (env.PULLBOARD_TEST_ACTIONS) options.reporters.push({ reporter: fileURLToPath(new URL('./test/action/reporter.js', import.meta.url)), destination: devNull });
  if (env.PULLBOARD_TEST_SELECTION) options.reporters.push({ reporter: fileURLToPath(new URL('./test/selection.js', import.meta.url)), destination: devNull });
  return reportDispatchedTests(options, env, loadCustomReporter);
}

/** Convert the Node test CLI subset to the supported node:test run() options. */
async function landingTestOptions(args, env, concurrency) {
  const { testFileOptions } = await import('./test/file/dispatch.js');
  return testFileOptions(args, env, concurrency, { runner, optionTakesValue, knownNodeOption });
}

/** Parse a POSIX process census into PID, group, and start identities used for safe cleanup. */
function parseLandingProcessTable(output) {
  const processes = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
    if (!match) continue;
    const [, pidText, ppidText, pgidText, state, rest] = match;
    const fields = rest.trim().split(/\s+/u);
    if (fields.length < 5) continue;
    const started = fields.slice(0, 5).join(' ');
    const command = fields.slice(5).join(' ');
    processes.push({ pid: Number(pidText), ppid: Number(ppidText), pgid: Number(pgidText), state, started, command, depth: 0 });
  }
  return processes;
}

/** Snapshot process identities on POSIX hosts, where the runner can verify process ancestry. */
function landingProcessTable() {
  if (process.platform === 'win32') return [];
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 << 20 });
  return parseLandingProcessTable(output);
}

/** Mark a worker identity retry interrupted by the runner's explicit SIGTERM cancellation. */
function landingWorkerCancellationError(cause) {
  const error = new Error('landing test worker identity retry was interrupted', cause ? { cause } : undefined);
  error.code = 'LANDING_CANCELLED';
  return error;
}

/** Retry a worker's initial process-identity receipt without blocking its event loop or exceeding the file-start ceiling. */
async function landingWorkerIdentity(pid, timeoutMs = LANDING_WORKER_IDENTITY_TIMEOUT_MS) {
  if (process.platform === 'win32') return null;
  const { args: snapshotArgs } = workerProcessIdentityQuery(pid);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let retryNoticeReported = false;
  let stopping = false;
  let snapshotChild = null;
  const stopSnapshot = () => {
    stopping = true;
    snapshotChild?.kill('SIGTERM');
  };
  process.once('SIGTERM', stopSnapshot);
  try {
    while (Date.now() < deadline) {
      if (stopping) throw landingWorkerCancellationError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const output = await new Promise((resolveOutput, rejectOutput) => {
          const child = execFile('ps', snapshotArgs, {
            encoding: 'utf8', timeout: Math.min(2000, Math.max(1, remaining)),
          }, (error, stdout) => {
            if (snapshotChild === child) snapshotChild = null;
            error ? rejectOutput(error) : resolveOutput(stdout);
          });
          snapshotChild = child;
          if (stopping) child.kill('SIGTERM');
        });
        if (stopping) throw landingWorkerCancellationError();
        const identity = parseWorkerProcessIdentity(output);
        if (identity?.pid === pid) {
          if (stopping) throw landingWorkerCancellationError();
          return identity;
        }
      } catch (error) {
        if (stopping || error.code === 'LANDING_CANCELLED') throw landingWorkerCancellationError(error);
        lastError = error;
        if (!retryNoticeReported) {
          retryNoticeReported = true;
          const timedOut = isWorkerProcessIdentityTimeout(error, pid);
          process.stderr.write(timedOut
            ? 'run-tests: worker identity snapshot timed out; retrying before file execution\n'
            : `run-tests: worker identity snapshot failed (${error.code ?? 'unknown'}); retrying before file execution\n`);
        }
      }
      const wait = Math.min(100, deadline - Date.now());
      if (wait > 0) await new Promise(resolveReady => setTimeout(resolveReady, wait));
    }
    if (stopping) throw landingWorkerCancellationError();
    const unavailable = new Error(`landing test worker identity was unavailable within ${timeoutMs}ms`, { cause: lastError });
    unavailable.code = 'LANDING_IDENTITY_UNAVAILABLE';
    throw unavailable;
  } finally {
    process.off('SIGTERM', stopSnapshot);
    snapshotChild = null;
  }
}

/** Snapshot descendants only from worker identities still matching their startup receipts. */
function landingWorkerDescendants(workerRoots, processes = landingProcessTable()) {
  if (!workerRoots.length || process.platform === 'win32') return [];
  const byParent = new Map();
  const byPid = new Map(processes.map(processInfo => [processInfo.pid, processInfo]));
  for (const child of processes) {
    const children = byParent.get(child.ppid) ?? [];
    children.push(child);
    byParent.set(child.ppid, children);
  }
  const found = [];
  const validRoots = workerRoots.filter(root => sameProcessIdentity(byPid.get(root.pid), root));
  const visited = new Set(validRoots.map(root => root.pid));
  const queue = validRoots.map(root => ({ pid: root.pid, depth: 0 }));
  while (queue.length) {
    const parent = queue.shift();
    for (const child of byParent.get(parent.pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      child.depth = parent.depth + 1;
      found.push(child);
      queue.push({ pid: child.pid, depth: child.depth });
    }
  }
  return found;
}

/** Confirm a direct child is the announced Node worker for exactly one selected test file. */
function landingWorkerCommandMatchesFile(processInfo, file) {
  const command = processInfo.command.trimEnd();
  const executable = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  if (!executable) return false;
  const executablePath = executable[1] ?? executable[2] ?? executable[3];
  // ps prints an executable containing spaces without shell quotes; match its complete known path first.
  const exactExecutable = command.startsWith(process.execPath) && /^(?:\s|$)/u.test(command.slice(process.execPath.length));
  if (!exactExecutable && basename(executablePath) !== basename(process.execPath)) return false;
  let offset = command.indexOf(file);
  while (offset !== -1) {
    const before = offset === 0 || /[\s"']/u.test(command[offset - 1]);
    const afterIndex = offset + file.length;
    const after = afterIndex === command.length || /[\s"']/u.test(command[afterIndex]);
    if (before && after) return true;
    offset = command.indexOf(file, offset + 1);
  }
  return false;
}

/** Match an announced ChildProcess spawn to the fresh command line without trusting its PID alone. */
function landingChildCommandMatchesSpawn(processInfo, receipt) {
  const command = processInfo.command.trimEnd();
  const executable = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  const spawnFile = receipt.spawnFile;
  const exactExecutable = typeof spawnFile === 'string' && spawnFile.length > 0
    && command.startsWith(spawnFile) && /^(?:\s|$)/u.test(command.slice(spawnFile.length));
  if (!exactExecutable && (!executable || basename(executable[1] ?? executable[2] ?? executable[3]) !== basename(spawnFile ?? ''))) return false;
  return receipt.spawnArgs.slice(1).every(argument => {
    if (typeof argument !== 'string' || !argument) return false;
    let offset = command.indexOf(argument);
    while (offset !== -1) {
      const before = offset === 0 || /[\s"']/u.test(command[offset - 1]);
      const afterIndex = offset + argument.length;
      const after = afterIndex === command.length || /[\s"']/u.test(command[afterIndex]);
      if (before && after) return true;
      offset = command.indexOf(argument, offset + 1);
    }
    return false;
  });
}

/** Snapshot detached children at spawn time, retaining worker uncertainty when that snapshot fails. */
function watchLandingChildSpawns(startsPath, attempt, file = null) {
  let recording = false;
  channel('child_process').subscribe(({ process: child }) => {
    if (recording || !child || typeof child.once !== 'function') return;
    child.once('spawn', () => {
      if (!Number.isInteger(child.pid)) return;
      recording = true;
      try {
        const byPid = new Map(landingProcessTable().map(processInfo => [processInfo.pid, processInfo]));
        const parent = byPid.get(process.pid);
        const spawned = byPid.get(child.pid);
        if (parent && spawned && spawned.pgid !== parent.pgid) {
          appendFileSync(startsPath, `${JSON.stringify({ type: 'child', attempt, parentPid: process.pid,
            pid: spawned.pid, pgid: spawned.pgid, started: spawned.started })}\n`);
        }
      } catch (error) {
        // A worker can exit before the next ancestry census; absence then cannot prove its children drained.
        if (!file) return;
        const code = String(error?.code ?? 'snapshot-error').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 80);
        const reason = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256);
        try {
          appendFileSync(startsPath, `${JSON.stringify({ type: 'child-snapshot-unavailable', attempt,
            file, parentPid: process.pid, pid: child.pid, code, reason })}\n`);
        } catch {
          process.stderr.write(`run-tests: cleanup for ${basename(file)} UNVERIFIED: ${code}: ${reason}; no unverified process was signaled\n`);
        }
      }
      finally { recording = false; }
    });
  });
}

/** Publish child announcements without inspection, then retain degraded-worker custody until the parent responds. */
function watchLandingChildCustody(startsPath, attempt) {
  let sequence = 0;
  const pending = new Map();
  let poll = null;
  let announcementFailureDeadline = null;
  let announcedUnavailable = false;
  let announcementFailureReportedToParent = false;
  const directory = dirname(startsPath);
  const prefix = `${basename(startsPath)}.child.${attempt}.${process.pid}.`;
  const pollAcks = () => {
    if (!pending.size && announcementFailureDeadline === null) return;
    try {
      for (const name of readdirSync(directory)) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        const recordPath = join(directory, name);
        if (!existsSync(`${recordPath}.ack`)) continue;
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        const ack = JSON.parse(readFileSync(`${recordPath}.ack`, 'utf8'));
        if (record.attempt !== attempt || record.parentPid !== process.pid
            || ack.attempt !== attempt || ack.parentPid !== process.pid || ack.pid !== record.pid
            || !['bound', 'drained', 'unverified'].includes(ack.status)) continue;
        pending.delete(recordPath);
        renameSync(`${recordPath}.ack`, `${recordPath}.acked`);
      }
    } catch { /* An unreadable acknowledgement retains worker custody. */ }
    const now = Date.now();
    const expired = [...pending].filter(([, deadline]) => now >= deadline).map(([path]) => path);
    if (expired.length) {
      for (const recordPath of expired) {
        pending.delete(recordPath);
        try {
          const marker = `${recordPath}.expired`;
          if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ attempt, parentPid: process.pid,
            expiredAt: new Date(now).toISOString() }), { mode: 0o600, flag: 'wx' });
        } catch { /* Parent-side cleanup reports uncertainty from the original child receipt. */ }
      }
    }
    if (announcementFailureDeadline !== null && now >= announcementFailureDeadline && !announcedUnavailable) {
      announcedUnavailable = true;
      if (!announcementFailureReportedToParent) {
        process.stderr.write('run-tests: cleanup for selected test file UNVERIFIED: child ownership announcement failed; no unverified process was signaled\n');
      }
    }
    if (!pending.size && (announcementFailureDeadline === null || announcedUnavailable) && poll) { clearInterval(poll); poll = null; }
  };
  channel('child_process').subscribe(({ process: child }) => {
    if (!child || typeof child.once !== 'function') return;
    child.once('spawn', () => {
      if (!Number.isInteger(child.pid)) return;
      const recordPath = join(directory, `${prefix}${sequence++}.${randomUUID()}.json`);
      const record = { type: 'child-pending', attempt, file: process.env.PULLBOARD_TEST_FILE,
        parentPid: process.pid, pid: child.pid, spawnFile: child.spawnfile,
        spawnArgs: Array.isArray(child.spawnargs) ? child.spawnargs : [] };
      try {
        const temporary = `${recordPath}.tmp`;
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, recordPath);
        pending.set(recordPath, Date.now() + LANDING_CHILD_CUSTODY_TIMEOUT_MS);
        if (!poll) poll = setInterval(pollAcks, 25);
      } catch (error) {
        announcementFailureDeadline ??= Date.now() + LANDING_CHILD_CUSTODY_TIMEOUT_MS;
        const code = String(error?.code ?? 'announcement-error').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 80);
        const reason = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256);
        let failurePublished = false;
        try {
          const failed = `${recordPath}.failure.json`;
          const temporary = `${failed}.${randomUUID()}.tmp`;
          writeFileSync(temporary, JSON.stringify({ type: 'child-announcement-failed', attempt,
            file: record.file, parentPid: process.pid, pid: child.pid, code, reason }), { mode: 0o600, flag: 'wx' });
          renameSync(temporary, failed);
          failurePublished = true;
        } catch { /* The worker still releases on its bounded timer; no process is signaled by guess. */ }
        try {
          appendFileSync(startsPath, `${JSON.stringify({ type: 'child-announcement-unavailable', attempt,
            file: record.file, parentPid: process.pid, pid: child.pid, code, reason })}\n`);
          failurePublished = true;
        } catch { /* Worker stderr is the last bounded diagnostic fallback. */ }
        announcementFailureReportedToParent ||= failurePublished;
        if (!poll) poll = setInterval(pollAcks, 25);
      }
    });
  });
}

/** Match a PID to its captured identity so cleanup never signals a reused PID. */
function sameProcessIdentity(candidate, captured) {
  return candidate && candidate.pid === captured.pid && candidate.pgid === captured.pgid && candidate.started === captured.started;
}

/** Publish an acknowledgement only after the parent has bound a child identity or observed a previously bound exit. */
function writeChildAcknowledgement(recordPath, receipt, identity, status) {
  const acknowledgement = `${recordPath}.ack`;
  if (existsSync(acknowledgement) || existsSync(`${recordPath}.acked`)) return;
  const temporary = `${acknowledgement}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ attempt: receipt.attempt, parentPid: receipt.parentPid,
    pid: receipt.pid, status, identity }), { mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, acknowledgement); }
  catch (error) { rmSync(temporary, { force: true }); if (error.code !== 'EEXIST') throw error; }
}

/** Read only complete append-only worker journal rows while workers may be writing. */
function landingWorkerReceipts(path) {
  const contents = readFileSync(path, 'utf8');
  const complete = contents.endsWith('\n') ? contents : contents.slice(0, contents.lastIndexOf('\n') + 1);
  return complete.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

/**
 * True when a kill that failed with ESRCH or EPERM hit a process this run no longer owns: it is gone,
 * a zombie, or its pid now belongs to another process. Under load a process can exit, or its pid be
 * reused, between the census and the signal, and macOS answers EPERM for some of those (#850). Each
 * such answer is logged; an EPERM for a process that is still ours is a real permission error.
 */
export function killAnsweredGone(error, owned, snapshot) {
  if (error.code !== 'ESRCH' && error.code !== 'EPERM') return false;
  if (error.code === 'EPERM') {
    const fresh = snapshot();
    // No census, no verdict: keep the identity and let the next sweep decide.
    if (!fresh) return true;
    const live = fresh.get(owned.pid);
    if (sameProcessIdentity(live, owned) && !live.state.startsWith('Z')) return false;
  }
  process.stderr.write(`run-tests: kill ${owned.pid} answered ${error.code}; that process is gone or no longer ours, so it counts as gone\n`);
  return true;
}

/** Terminate owned descendants as the live receipt set grows, then wait for the run and every identity to drain. */
async function drainLandingWorkerDescendants(ownedDescendants, refreshOwnedDescendants, runFinished, reportUnverified, cleanupDeadline) {
  let firstError = null;
  let snapshotFailureSince = null;
  let lastSnapshotError = null;
  const rememberError = error => {
    firstError ??= error;
    if (firstError === error) {
      process.stderr.write(`run-tests: descendant cleanup encountered ${error.message}; retaining the gate slot until captured processes drain\n`);
    }
  };
  const rememberSnapshotError = error => {
    snapshotFailureSince ??= Date.now();
    lastSnapshotError = error;
  };
  const snapshot = () => {
    try { return new Map(landingProcessTable().map(processInfo => [processInfo.pid, processInfo])); }
    catch (error) { rememberSnapshotError(error); return null; }
  };
  const signalDue = captured => {
    const current = snapshot();
    if (!current) return;
    const now = Date.now();
    for (const owned of captured) {
      const live = current.get(owned.pid);
      if (!sameProcessIdentity(live, owned) || live.state.startsWith('Z')) continue;
      const key = `${owned.pid}:${owned.pgid}:${owned.started}`;
      const state = signalState.get(key) ?? { termAt: null, killSent: false };
      const signal = state.termAt === null ? 'SIGTERM' : now - state.termAt >= 750 && !state.killSent ? 'SIGKILL' : null;
      if (!signal) continue;
      try {
        process.kill(owned.pid, signal);
        if (signal === 'SIGTERM') state.termAt = now;
        else state.killSent = true;
      } catch (error) {
        if (killAnsweredGone(error, owned, snapshot)) continue;
        rememberError(error);
      }
      signalState.set(key, state);
    }
  };
  const remaining = () => {
    const current = snapshot();
    if (!current) return null;
    return [...ownedDescendants.values()].filter(owned => {
      const live = current.get(owned.pid);
      return sameProcessIdentity(live, owned) && !live.state.startsWith('Z');
    });
  };
  const signalState = new Map();
  let nextSignal = 0;
  let runFinishedWithoutOwnedProcesses = false;
  let unresolvedSince = null;
  while (true) {
    let captureSucceeded = false;
    try {
      captureSucceeded = refreshOwnedDescendants() !== false;
    } catch (error) { rememberSnapshotError(error); }
    if (captureSucceeded) unresolvedSince = null;
    else unresolvedSince ??= Date.now();
    const stillOwned = remaining();
    if (captureSucceeded && stillOwned) { snapshotFailureSince = null; lastSnapshotError = null; }
    if ((snapshotFailureSince || unresolvedSince) && Date.now() >= cleanupDeadline) {
      reportUnverified(lastSnapshotError);
      break;
    }
    if (runFinished() && captureSucceeded && stillOwned && stillOwned.length === 0) {
      if (runFinishedWithoutOwnedProcesses) break;
      runFinishedWithoutOwnedProcesses = true;
    } else {
      runFinishedWithoutOwnedProcesses = false;
    }
    if (Date.now() >= nextSignal) {
      signalDue([...ownedDescendants.values()]);
      nextSignal = Date.now() + 100;
    }
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  if (firstError) throw new Error(`owned descendants drained after cleanup error: ${firstError.message}`, { cause: firstError });
}

/** Run a landing check with execution-ordered failure detection and native runner reporters. */
async function runLandingTests(args, env, concurrency, fullScope = false) {
  const collectAll = process.env[LANDING_COLLECT_ALL_ENV] === '1';
  const collectionId = process.env[COLLECTION_ID_ENV];
  const collectionShard = process.env[LANDING_SHARD_ENV] ?? null;
  const { landingFailureReport, landingWaiverProjection, landingFailureWaived, publishLandingCollection } = await services.landing();
  const retainedFailure = landingFailureReport();
  const waivers = landingWaiverProjection(process.env[LANDING_WAIVERS_ENV]);
  let testOutcomes = null;
  const waivedFiles = new Map();
  const hungFiles = new Set();
  const { dispatchTestFiles, legacyFileMode } = await import('./test/file/dispatch.js');
  const { run } = await import('node:test');
  const legacy = legacyFileMode(args);
  const { PassThrough } = await import('node:stream');
  const { createWriteStream } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { options, env: testEnv } = await landingTestOptions(args, env, concurrency);
  delete testEnv[LANDING_WAIVERS_ENV];
  for (const name of [LANDING_COLLECT_ALL_ENV, COLLECTION_ID_ENV, 'PULLBOARD_RELEASE_EXECUTORS']) delete testEnv[name];
  if (options.isolation !== 'process') {
    throw new Error('landing gate early-stop requires --test-isolation=process so started files and owned children can be tracked safely');
  }
  if (process.platform === 'win32') {
    throw new Error('landing gate early-stop requires POSIX process identities to track and drain started files safely');
  }
  const attempt = randomUUID();
  const workerStartsPath = join(testEnv.TMPDIR ?? tmpdir(), `landing-worker-starts-${attempt}.jsonl`);
  writeFileSync(workerStartsPath, '', { mode: 0o600 });
  testEnv[LANDING_WORKER_STARTS_ENV] = workerStartsPath;
  testEnv[LANDING_ATTEMPT_ENV] = attempt;
  watchLandingChildSpawns(workerStartsPath, attempt);
  const selectedFiles = options.selectedFiles;
  if (!legacy) { options.files = selectedFiles; delete options.shard; }
  delete options.selectedFiles;
  if (env.PULLBOARD_AUDIT_COVERAGE_REPORTER) {
    options.coverage = true;
    options.reporters.push({ reporter: env.PULLBOARD_AUDIT_COVERAGE_REPORTER, destination: 'stdout' });
  }
  const reporterEntries = options.reporters;
  if (process.env.PULLBOARD_TEST_ACTIONS) reporterEntries.push({ reporter: fileURLToPath(new URL('./test/action/reporter.js', import.meta.url)), destination: devNull });
  if (testEnv.PULLBOARD_TEST_SELECTION) reporterEntries.push({ reporter: fileURLToPath(new URL('./test/selection.js', import.meta.url)), destination: devNull });
  delete options.reporters;
  const loadedReporters = [];
  for (const entry of reporterEntries) {
    let reporter;
    if (['tap', 'spec', 'dot', 'junit', 'lcov'].includes(entry.reporter)) {
      reporter = (await import('node:test/reporters'))[entry.reporter];
    } else {
      const moduleSpecifier = entry.reporter.startsWith('.') || entry.reporter.startsWith('/')
        ? pathToFileURL(resolve(entry.reporter)).href : entry.reporter;
      const imported = await import(moduleSpecifier);
      reporter = imported.default;
    }
    if (!reporter) throw new Error(`unknown test reporter: ${entry.reporter}`);
    loadedReporters.push(reporter);
  }
  const reporters = [];
  const reporterEnds = [];
  const controller = new AbortController();
  let reporterError = null;
  for (const [index, entry] of reporterEntries.entries()) {
    const reporter = loadedReporters[index];
    const input = new PassThrough({ objectMode: true });
    const output = input.compose(reporter);
    const destination = entry.destination === 'stdout' ? process.stdout
      : entry.destination === 'stderr' ? process.stderr : createWriteStream(resolve(entry.destination));
    const readableEnd = new Promise(resolveEnd => {
      output.once('end', resolveEnd);
      output.once('close', resolveEnd);
    });
    const handleReporterError = error => { reporterError ??= error; abortLandingRun(); };
    if (entry.destination === 'stdout' || entry.destination === 'stderr') {
      output.once('error', handleReporterError);
      destination.once('error', handleReporterError);
      output.pipe(destination);
      reporterEnds.push(readableEnd.finally(() => destination.off('error', handleReporterError)));
    } else {
      const writableEnd = new Promise((resolveEnd, reject) => {
        destination.once('finish', resolveEnd);
        destination.once('error', error => { handleReporterError(error); reject(error); });
        output.once('error', error => { handleReporterError(error); reject(error); });
      });
      output.pipe(destination);
      reporterEnds.push(Promise.all([readableEnd, writableEnd]).catch(error => { reporterError = error; abortLandingRun(); }));
    }
    reporters.push(input);
  }
  const startedFiles = new Set();
  const completedFiles = new Set();
  const failureDiagnostics = new Map();
  let firstFailure = null;
  let collectionCancelled = false;
  let successful = true;
  let reportersEnded = false;
  let abortCleaned = false;
  let abortPromise = null;
  let cleanupDeadline = null;
  let workerDrain = Promise.resolve();
  let runFinished = false;
  const ownedDescendants = new Map();
  const pendingWorkerBindings = new Map();
  const pendingChildBindings = new Map();
  const unverifiedChildBindings = new Set();
  const acknowledgedChildDrains = new Set();
  const selectedFileSet = new Set(selectedFiles ?? []);
  let cleanupUnverifiedReported = false;
  let lastCleanupSnapshotError = null;
  const cleanupUnverifiedFiles = new Set();
  const reportCleanupUnverified = error => {
    if (cleanupUnverifiedReported) return;
    cleanupUnverifiedReported = true;
    const files = [...cleanupUnverifiedFiles].map(file => basename(file));
    const fallbackFiles = [...selectedFileSet].map(file => basename(file));
    const namedFiles = files.length ? files : fallbackFiles;
    const shownFiles = namedFiles.slice(0, 12);
    const subject = shownFiles.length ? `${shownFiles.join(', ')}${namedFiles.length > shownFiles.length ? ` (+${namedFiles.length - shownFiles.length} more)` : ''}` : 'selected test files';
    const code = String(error?.code ?? 'snapshot-unavailable')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 80);
    const detail = String(error?.message ?? 'process identity census unavailable')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256);
    const reason = detail === code ? code : `${code}: ${detail}`;
    process.stderr.write(`run-tests: cleanup for ${subject} UNVERIFIED: ${reason}; no unverified process was signaled\n`);
  };
  const rememberSnapshotError = error => {
    lastCleanupSnapshotError = error;
  };
  const captureOwnedDescendants = () => {
    const processes = landingProcessTable();
    const receipts = landingWorkerReceipts(workerStartsPath).filter(receipt => receipt.attempt === attempt);
    const current = new Map(processes.map(processInfo => [processInfo.pid, processInfo]));
    const workerRoots = receipts.filter(receipt => receipt.type === 'worker' && selectedFileSet.has(receipt.file)
      && sameProcessIdentity(current.get(receipt.pid), receipt));
    for (const receipt of receipts) {
      if (receipt.type !== 'worker-pending' || !selectedFileSet.has(receipt.file)
          || receipt.parentPid !== process.pid || !Number.isInteger(receipt.pid)) continue;
      const key = `${receipt.attempt}:${receipt.pid}:${receipt.file}`;
      const previouslyBound = pendingWorkerBindings.get(key);
      if (previouslyBound) {
        if (sameProcessIdentity(current.get(previouslyBound.pid), previouslyBound)) workerRoots.push(previouslyBound);
        continue;
      }
      const candidate = current.get(receipt.pid);
      if (!candidate || candidate.ppid !== process.pid || candidate.state.startsWith('Z')
          || !Number.isInteger(candidate.pgid) || !candidate.started
          || !landingWorkerCommandMatchesFile(candidate, receipt.file)) continue;
      // Bind an announcement once. A later process reusing this PID can never replace it.
      pendingWorkerBindings.set(key, candidate);
      workerRoots.push(candidate);
      appendFileSync(workerStartsPath, `${JSON.stringify({ type: 'worker-bound', attempt, file: receipt.file,
        pid: candidate.pid, parentPid: process.pid, pgid: candidate.pgid, started: candidate.started })}\n`);
    }
    const workerByPid = new Map(workerRoots.map(root => [root.pid, root]));
    let unsettledChild = false;
    for (const receipt of receipts) {
      if (!['child-announcement-unavailable', 'child-snapshot-unavailable'].includes(receipt.type)
          || !selectedFileSet.has(receipt.file)) continue;
      unsettledChild = true;
      cleanupUnverifiedFiles.add(receipt.file);
      lastCleanupSnapshotError = { code: receipt.code, message: receipt.reason };
    }
    for (const name of readdirSync(dirname(workerStartsPath))) {
      const prefix = `${basename(workerStartsPath)}.child.${attempt}.`;
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const recordPath = join(dirname(workerStartsPath), name);
      let receipt;
      try { receipt = JSON.parse(readFileSync(recordPath, 'utf8')); }
      catch { continue; }
      if (receipt.type === 'child-announcement-failed' && receipt.attempt === attempt
          && selectedFileSet.has(receipt.file)) {
        unsettledChild = true;
        cleanupUnverifiedFiles.add(receipt.file);
        lastCleanupSnapshotError = { code: receipt.code, message: receipt.reason };
        continue;
      }
      if (receipt.type !== 'child-pending' || receipt.attempt !== attempt || !selectedFileSet.has(receipt.file)
          || !Number.isInteger(receipt.parentPid) || !Number.isInteger(receipt.pid)) continue;
      const key = `${receipt.attempt}:${receipt.parentPid}:${receipt.pid}:${name}`;
      if (unverifiedChildBindings.has(key)) continue;
      const prior = pendingChildBindings.get(key);
      if (prior) {
        const live = current.get(prior.pid);
        if (sameProcessIdentity(live, prior)) ownedDescendants.set(`${prior.pid}:${prior.pgid}:${prior.started}`, prior);
        else if (!live || live.state.startsWith('Z')) {
          if (!acknowledgedChildDrains.has(key)) {
            writeChildAcknowledgement(recordPath, receipt, prior, 'drained');
            acknowledgedChildDrains.add(key);
          }
        }
        else unsettledChild = true;
        continue;
      }
      const worker = workerByPid.get(receipt.parentPid);
      const candidate = current.get(receipt.pid);
      if (!worker || !candidate || candidate.ppid !== worker.pid || candidate.state.startsWith('Z')
          || !Number.isInteger(candidate.pgid) || !candidate.started
          || !landingChildCommandMatchesSpawn(candidate, receipt)) { unsettledChild = true; cleanupUnverifiedFiles.add(receipt.file); continue; }
      // Capture ownership before acknowledging. The worker cannot exit/reparent this child first.
      pendingChildBindings.set(key, candidate);
      ownedDescendants.set(`${candidate.pid}:${candidate.pgid}:${candidate.started}`, candidate);
      writeChildAcknowledgement(recordPath, receipt, candidate, 'bound');
    }
    const childRoots = receipts.filter(receipt => receipt.type === 'child' && sameProcessIdentity(current.get(receipt.pid), receipt));
    const knownRoots = [...ownedDescendants.values()].filter(root => sameProcessIdentity(current.get(root.pid), root));
    for (const root of childRoots) ownedDescendants.set(`${root.pid}:${root.pgid}:${root.started}`, current.get(root.pid));
    for (const child of landingWorkerDescendants([...workerRoots, ...childRoots, ...knownRoots], processes)) {
      ownedDescendants.set(`${child.pid}:${child.pgid}:${child.started}`, child);
    }
    return !unsettledChild;
  };
  const markPendingChildrenUnverified = () => {
    const prefix = `${basename(workerStartsPath)}.child.${attempt}.`;
    for (const name of readdirSync(dirname(workerStartsPath))) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const recordPath = join(dirname(workerStartsPath), name);
      let receipt;
      try { receipt = JSON.parse(readFileSync(recordPath, 'utf8')); }
      catch { continue; }
      if (receipt.type === 'child-announcement-failed' && receipt.attempt === attempt
          && selectedFileSet.has(receipt.file)) {
        cleanupUnverifiedFiles.add(receipt.file);
        lastCleanupSnapshotError = { code: receipt.code, message: receipt.reason };
        continue;
      }
      if (receipt.type !== 'child-pending' || receipt.attempt !== attempt || !selectedFileSet.has(receipt.file)) continue;
      const key = `${receipt.attempt}:${receipt.parentPid}:${receipt.pid}:${name}`;
      if (pendingChildBindings.has(key)) continue;
      cleanupUnverifiedFiles.add(receipt.file);
      if (!existsSync(`${recordPath}.expired`)) writeChildAcknowledgement(recordPath, receipt, null, 'unverified');
      unverifiedChildBindings.add(key);
    }
  };
  // Capture identities while worker ancestry still exists; a detached child can be
  // reparented before the failure event reaches this process.
  const descendantMonitor = setInterval(() => {
    try { captureOwnedDescendants(); }
    catch (error) { rememberSnapshotError(error); }
  }, 1000);
  descendantMonitor.unref();
  const endReporters = () => {
    if (reportersEnded) return;
    reportersEnded = true;
    for (const reporter of reporters) reporter.end();
  };
  const abortLandingRun = () => {
    if (abortPromise) return abortPromise;
    abortCleaned = true;
    cleanupDeadline = Date.now() + LANDING_CHILD_CUSTODY_TIMEOUT_MS;
    let resolveAbort;
    abortPromise = new Promise(resolve => { resolveAbort = resolve; });
    void (async () => {
      try {
        const captured = captureOwnedDescendants();
        if (!captured) {
          markPendingChildrenUnverified();
          reportCleanupUnverified(lastCleanupSnapshotError);
        }
      } catch (error) {
        rememberSnapshotError(error);
        markPendingChildrenUnverified();
        reportCleanupUnverified(lastCleanupSnapshotError);
      } finally {
        controller.abort();
      }
    })().then(resolveAbort, error => { reporterError ??= error; resolveAbort(); });
    return abortPromise;
  };
  // A shard the landing stops gets TERM: stop through the same custody as a first failure, so every
  // owned descendant, detached ones included, is drained or named before this process exits.
  let stoppedByLanding = false;
  const stopShard = () => { stoppedByLanding = true; abortLandingRun(); };
  if (process.env[LANDING_SHARD_ENV]) process.on('SIGTERM', stopShard);
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, testEnv, { [LANDING_RUN_ENV]: '0' });
  try {
    const execute = legacy ? run : input => dispatchTestFiles(input, testEnv);
    const stream = execute({ ...options, signal: controller.signal,
      setup(tests) {
        // A HUNG or wall-TIMEOUT file stays red, but its watchdog must not cancel the remaining named files (#3167).
        tests.on('test:stderr', data => {
          if (data.file && /run-tests: (?:HUNG|TIMEOUT) file /u.test(data.message ?? '')) hungFiles.add(data.file);
        });
        tests.on('test:complete', data => {
          const { file, name, details } = data;
          // Node 22.13 leaves ordinary/file completions untyped; newer versions label them as tests.
          if (file && details?.passed === false && (details.type === undefined || details.type === 'test') && !firstFailure) {
            if (hungFiles.has(file)) return;
            // Once this shard stops, its in-flight files end aborted: interrupted by the stop, never its first failure.
            if (controller.signal.aborted || details.error?.failureType === 'testAborted') return;
            // A failure a live person waiver covers does not stop the run; every other file still runs.
            if (landingFailureWaived(waivers, file, name)) { waivedFiles.set(file, waivedFiles.get(file) ?? true); return; }
            // A file or suite failing only through its tests was decided by those tests already.
            if (waivers.length && details.error?.failureType === 'subtestsFailed' && waivedFiles.get(file) === true) return;
            waivedFiles.set(file, false);
            firstFailure = { file, name, error: details.error };
            retainedFailure.remember(data);
            // Node emits completion before finalizing its result. Aborting inside that callback
            // replaces the real failure with cancellation; let the current publication finish.
            if (!collectAll) queueMicrotask(abortLandingRun);
          }
        });
        tests.on('test:summary', data => {
          if (data.success === false) successful = false;
          if (data.file) {
            startedFiles.add(data.file);
            // A file cancelled by this shard's stop did not complete; it is reported as interrupted, not failed.
            if (data.success === false && controller.signal.aborted) return;
            completedFiles.add(data.file);
            if (data.success === false && !firstFailure && waivedFiles.get(data.file) !== true && !hungFiles.has(data.file)) {
              firstFailure = { file: data.file, name: 'test file failed before a test completed' };
              if (!collectAll) queueMicrotask(abortLandingRun);
            }
          }
        });
      },
    });
    stream.on('data', event => {
      event = retainedFailure.event(event);
      // Node 22's execution-complete event may describe only the failed file wrapper;
      // its ordered failure event retains the actual assertion once reporters drain.
      if (event.type === 'test:fail' && event.data.details?.error?.failureType === 'testAborted') collectionCancelled = true;
      if (event.type === 'test:fail') {
        const data = event.data;
        const error = data.details?.error;
        if (data.file && error && !['testAborted', 'subtestsFailed'].includes(error.failureType)
            && !failureDiagnostics.has(data.file)) failureDiagnostics.set(data.file, data);
      }
      for (const [index, reporter] of reporters.entries()) {
        // Node 22's human coverage tree reserves `file` as a key and crashes on a directory with that name.
        // The independent audit reporter and every custom reporter still receive the complete native event.
        if (env.PULLBOARD_AUDIT_COVERAGE_REPORTER && event.type === 'test:coverage'
          && ['tap', 'spec'].includes(reporterEntries[index].reporter)) continue;
        reporter.write(event);
      }
    });
    stream.on('end', endReporters);
    let streamClosed = false;
    let resolveClosed;
    const closed = new Promise(resolveDone => { resolveClosed = resolveDone; });
    stream.once('close', () => { streamClosed = true; resolveClosed(); });
    let streamErrored = false;
    await new Promise(resolveDone => {
      const finish = () => resolveDone();
      stream.once('end', finish);
      stream.once('close', finish);
      stream.once('error', error => {
        streamErrored = true;
        reporterError ??= error;
        abortLandingRun();
        endReporters();
        finish();
      });
    });
    if (streamErrored && !streamClosed) await closed;
    await abortPromise;
    await Promise.all(reporterEnds);
    testOutcomes = stream.testOutcomes ?? null;
    runFinished = true;
    for (const receipt of landingWorkerReceipts(workerStartsPath)) {
      if (receipt.attempt === attempt && ['worker', 'worker-identity-unavailable'].includes(receipt.type)
          && typeof receipt.file === 'string') startedFiles.add(receipt.file);
    }
  } finally {
    if (!abortCleaned) await abortLandingRun();
    else await abortPromise;
    runFinished = true;
    workerDrain = drainLandingWorkerDescendants(ownedDescendants, captureOwnedDescendants, () => runFinished,
      reportCleanupUnverified, cleanupDeadline ?? Date.now() + LANDING_CHILD_CUSTODY_TIMEOUT_MS)
      .catch(error => { reporterError ??= error; });
    await workerDrain;
    clearInterval(descendantMonitor);
    endReporters();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    process.off('SIGTERM', stopShard);
  }
  if (collectionId) publishLandingCollection({collectionId,collectionShard,fullScope,selectedFiles,completedFiles,stoppedByLanding,collectionCancelled,reporterError,cleanupUnverifiedReported});
  if (reporterError) throw reporterError;
  if (stoppedByLanding && !firstFailure) {
    process.stderr.write(`\nLanding shard ${process.env[LANDING_SHARD_ENV]} stopped by the landing after another shard failed; its owned processes were drained\n`);
    process.exitCode = 1;
    return { status: 1, signal: null };
  }
  if (firstFailure && !collectAll) {
    const diagnostic = failureDiagnostics.get(firstFailure.file);
    if (diagnostic) firstFailure = { file: firstFailure.file, name: diagnostic.name, error: diagnostic.details.error };
    const notRun = (selectedFiles ?? []).filter(file => !startedFiles.has(file));
    const interrupted = [...startedFiles].filter(file => !completedFiles.has(file));
    process.stderr.write(`\nLanding gate stopped early after ${firstFailure.file}: ${firstFailure.name}\n`);
    if (firstFailure.error) {
      const error = firstFailure.error;
      const cause = error.cause?.message;
      const message = [...new Set([error.message, cause].filter(Boolean))].join(': ')
        .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 4096);
      if (message) process.stderr.write(`Triggering test error: ${message}\n`);
    }
    if (interrupted.length) process.stderr.write(`Interrupted test files: ${interrupted.join(', ')}\n`);
    if (notRun.length) process.stderr.write(`Files not run: ${notRun.join(', ')}\n`);
    process.exitCode = 1;
    return { status: 1, signal: null };
  }
  return { status: successful && !firstFailure ? 0 : 1, signal: null, testOutcomes, completedFiles: [...completedFiles],
    collectionComplete: !stoppedByLanding && !collectionCancelled && !cleanupUnverifiedReported && selectedFiles?.length > 0
      && selectedFiles.every(file => completedFiles.has(file)) };
}

/**
 * Start the longest test files first, by the last landing's recorded wall times (#1046), so the slowest file
 * never starts last and holds the run open alone. Options and their values keep their places.
 *
 * @param {string[]} args
 * @returns {Promise<string[]>}
 */
async function longestFilesFirst(args) {
  const at = [];
  let takesValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (takesValue) { takesValue = false; continue; }
    if (argument === '--') { for (let rest = index + 1; rest < args.length; rest += 1) at.push(rest); break; }
    if (argument.startsWith('-')) {
      if (!argument.includes('=')) takesValue = optionTakesValue(argument);
      continue;
    }
    at.push(index);
  }
  if (at.length < 2) return args;
  const { readFileTimes } = await import('./test/value/timing.js');
  const times = readFileTimes(process.cwd());
  if (!Object.keys(times).length) return args;
  const ordered = longestFirst(at.map(index => args[index]), times, file => relative(process.cwd(), resolve(file)));
  const result = [...args];
  at.forEach((index, position) => { result[index] = ordered[position]; });
  return result;
}

/** Admit only explicit regular in-root files; directories and uncertain options remain ordinary. */
function namesOnlyTestFiles(args) {
  let takesValue = false;
  for (const argument of args) {
    if (takesValue) { takesValue = false; continue; }
    if (argument === '--') break;
    if (!argument.startsWith('-')) continue;
    const option = argument.split('=', 1)[0].replaceAll('_', '-');
    const requiresValue = optionTakesValue(option);
    if (!knownNodeOption(option)) return false;
    if (!argument.includes('=')) takesValue = requiresValue;
  }
  if (takesValue || foreignNodeOptions(process.env.NODE_OPTIONS)) return false;
  const files = explicitTestFiles(args);
  if (!files.length) return false;
  try {
    const root = realpathSync(process.cwd());
    return files.every(file => {
      const path = resolve(root, file);
      return lstatSync(path).isFile() && realpathSync(path).startsWith(root + sep);
    });
  } catch { return false; }
}





/** Run tests in the disposable environment, preserving a marker only when a parent holds the slot. */
async function executeTests(args, sandbox, gateMarkers, fullSuite, concurrency, timing) {
  const setupAt = performance.now();
  const env = testEnvironment(sandbox, gateMarkers);
  timing.phase('setupMs', setupAt);
  const patterns = testSelectionPatterns(args, optionTakesValue);
  if (patterns.length) env.PULLBOARD_TEST_SELECTION = join(sandbox, 'selected-tests.json');
  else delete env.PULLBOARD_TEST_SELECTION;
  // This is an inner file limit; the real machine gate/browser lease remains unchanged.
  env.PULLBOARD_TEST_BROWSER_RESOURCE = 'test-browser-files:' + randomUUID();
  env.PULLBOARD_TEST_BROWSER_CAPACITY = String(concurrency.browser);
  // Each file's worker classifies itself; the machine setting reaches it here, since tests get a private machine home.
  env.PULLBOARD_TEST_BROWSER_BY_LAUNCH = concurrency.byLaunch ? '1' : '';
  delete env.PULLBOARD_TEST_BROWSER_OWNER_PID;
  delete env.PULLBOARD_TEST_BROWSER_SLOT;
  let selectedArgs = args;
  if (fullSuite) {
    let files;
    try {
      files = isGitWorkTree(process.cwd(), env)
        ? trackedDefaultTestFiles(process.cwd(), env)
        : null;
    }
    catch (error) {
      process.stderr.write(`run-tests: could not list tracked test files: ${error.message}\n`);
      process.exitCode = 1;
      return { status: 1, signal: null };
    }
    if (files?.length === 0) {
      process.stderr.write('run-tests: no tracked Node test files found; refusing filesystem discovery\n');
      process.exitCode = 1;
      return { status: 1, signal: null };
    }
    if (files) selectedArgs = [...args, ...files];
  }
  const selectionAt = performance.now();
  selectedArgs = await longestFilesFirst(selectedArgs);
  timing.phase('selectionMs', selectionAt);
  const attemptAt = performance.now();
  const result = process.env[LANDING_RUN_ENV] === '1'
    ? await runLandingTests(selectedArgs, env, concurrency, fullSuite && patterns.length === 0)
    : await runTests(selectedArgs, env, concurrency);
  if (result.error) throw result.error;
  process.stderr.write(formatTestOutcomes(timing.id, result.testOutcomes));
  timing.complete(result, explicitTestFiles(selectedArgs), performance.now() - attemptAt);
  return selectedTestResult(result, env.PULLBOARD_TEST_SELECTION, patterns, explicitTestFiles(selectedArgs));
}

/**
 * Launch Node's test runner in a disposable environment and remove it after the run ends.
 *
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function main(args) {
  const clock = testRunPhaseClock();
  let concurrency;
  try {
    if (!args.length && !process.env.PULLBOARD_GATE_SLOT_HELD && !process.env.PULLBOARD_GATE_SLOT_POOL
      && !process.env.PULLBOARD_GATE_SLOT_TOKEN && !process.env[LANDING_SHARD_ENV]) {
      const [{ runFullSuite }, { runnerExecutionServices }, { landingExecutionServices }] = await Promise.all([
        import('../../index.js'), services.runners(), services.landing(),
      ]);
      const direct = await runFullSuite(process.cwd(), runner, { runners: runnerExecutionServices(), landing: landingExecutionServices() });
      if (direct) {
        // The CLI records the receipt in its own process, so this entry never imports the native board.
        if (direct.receiptId) try { spawnSync(process.execPath, [join(process.cwd(), 'apps/cli/pullboard.js'), 'flakes', 'record-suite', direct.receiptId], { cwd: process.cwd(), stdio: 'ignore', timeout: 60_000 }); } catch { /* the private receipt and the suite verdict stand */ }
        process.stdout.write(direct.output); process.exitCode = direct.isGreen ? 0 : 1; return;
      }
    }
    testTimeoutMs();
    const { testConcurrency } = await import('./test/concurrency.js');
    const { browserByLaunchEnabled } = await import('../../../config/index.js');
    concurrency = { ...testConcurrency(process.cwd()), byLaunch: browserByLaunchEnabled() };
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const timing = beginSuiteTiming(process.cwd(), args), selectionAt = performance.now();
  process.env[COLLECTION_ID_ENV] ||= timing.id;
  const sharding = shardArguments(args, optionTakesValue);
  if (sharding.error) {
    process.stderr.write(`run-tests: ${sharding.error}\n`);
    process.exitCode = 1;
    return;
  }
  args = sharding.args;
  const fullSuite = !hasTestFiles(args);
  const shortEligible = namesOnlyTestFiles(args);
  let browser = fullSuite;
  if (!browser) {
    const { testsNeedBrowser } = await import('./browser/admission.js');
    browser = await testsNeedBrowser(process.cwd(), explicitTestFiles(args));
  }
  const actions = await (await import('./test/action/cache.js')).planTestActions(process.cwd(), args, { fullSuite, landing: process.env[LANDING_RUN_ENV] === '1', listFiles: () => fullSuite ? trackedDefaultTestFiles(process.cwd(), process.env) : explicitTestFiles(args) });
  process.stderr.write(formatTestOutcomes(timing.id, actions.reusedTestOutcomes));
  if (actions.done) { timing.phase('selectionMs', selectionAt); return; }
  const { testsNeedGui } = await import('./gui/admission.js');
  let guiFiles;
  try {
    guiFiles = actions.files ?? (fullSuite
      ? (isGitWorkTree(process.cwd(), process.env) ? trackedDefaultTestFiles(process.cwd(), process.env) : [])
      : explicitTestFiles(args));
  } catch (error) {
    process.stderr.write(`run-tests: could not list tracked test files: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const gui = testsNeedGui(process.cwd(), guiFiles);
  const { cpuRunnerRequired } = await import('./admission/cpu/load.js');
  const runnerAdmission = (await import('../../../config/index.js')).gateRunnerAdmission();
  const runnerOnly = runnerAdmission.runnerOnly === true || cpuRunnerRequired(process.cwd(), guiFiles);
  timing.plan(fullSuite && isGitWorkTree(process.cwd(), process.env) ? trackedDefaultTestFiles(process.cwd(), process.env) : guiFiles,
    fullSuite && !narrowsSelection(args, optionTakesValue));
  timing.phase('selectionMs', selectionAt); clock.mark('selection');
  let signal = null;
  /** Keep sandbox lifetime inside the held lease, including the complete child process. */
  const shardLabel = process.env[LANDING_SHARD_ENV];
  const run = async (gateMarkers) => {
    const setupAt = performance.now();
    const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-test-run-'));
    // A shard of a sharded landing reports each file's wall time back to its orchestrator.
    const fileTimes = shardLabel ? join(sandbox, 'landing-file-times.jsonl') : '';
    // Observe leftovers around the whole execution, including failed cases; never remove clones.
    const cloneCheck = browser && process.platform === 'darwin'
      ? await import('../../index.js') : null;
    let clonesBefore;
    if (fileTimes) process.env[LANDING_FILE_TIMES_ENV] = fileTimes;
    try {
      clonesBefore = cloneCheck?.chromeCloneSnapshot();
      timing.phase('setupMs', setupAt); clock.mark('admission');
      const result = await executeTests(actions.args, sandbox, gateMarkers, fullSuite && !actions.files, concurrency, timing);
      signal = result.signal;
      process.exitCode = result.status ?? 1; clock.mark('tests');
      if (fileTimes) (await services.landing()).printShardFileTimes(fileTimes);
    } finally {
      try {
        if (clonesBefore) {
          const growth = cloneCheck.newChromeClones(clonesBefore);
          if (growth.length) {
            process.stderr.write(`run-tests: CHROME_CLONE_GROWTH: ${growth.length} new native clone directories remain; stop browser work and notify the coordinator\n`);
            process.exitCode = 1;
          }
        }
      } finally { (await import('./test/cleanup.js')).removeTestSandbox(sandbox); }
    }
  };
  try {
    const { GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, gateSlotEnvironment, inheritedGateSlot } = await import('../../../resources/index.js');
    const scopedMarker = process.env[GATE_SLOT_POOL_ENV] || process.env[GATE_SLOT_TOKEN_ENV];
    const legacyHeld = process.env[GATE_SLOT_HELD_ENV] === '1'; const ordinaryShards = process.env[LANDING_RUN_ENV] !== '1' && process.env.PULLBOARD_RUN_SHARDS !== '0';
    // A named-file landing shards its own selection too: fullSuite is only the scope, not the trigger (#1787), and a name
    // filter rides on every shard, so a name-filtered landing gate shards across runners instead of one local pass (#3158).
    if ((process.env[LANDING_RUN_ENV] === '1' || ordinaryShards) && !shardLabel) {
      const { landingShardCount, landingShardOptions, landingFanOutFiles, nativeFileArguments, freeRunnerSlots } = await import('../../index.js');
      let count = ordinaryShards ? freeRunnerSlots() : landingShardCount(process.cwd());
      // A gate already running in a runner slot is one shard of the controller's fan-out: it runs as one pass and never shards again.
      const insideRunnerSlot = scopedMarker ? inheritedGateSlot({ root: process.cwd(), browser })?.runnerExecution === true : false;
      shardedRun: if (!insideRunnerSlot && (count > 1 || process.env.PULLBOARD_RELEASE_EXECUTORS)) {
        const files = landingFanOutFiles(actions.files ?? (fullSuite // Globs expand and fold; a caller shard flag is refused.
          ? (isGitWorkTree(process.cwd(), process.env) ? trackedDefaultTestFiles(process.cwd(), process.env) : [])
          : explicitTestFiles(args)), actions.args, process.cwd(), optionTakesValue);
        if (!files.length && !ordinaryShards) throw new Error('a sharded landing gate needs tracked Node test files; commit them or set landingShards to 1');
        if (ordinaryShards && (count = Math.min(count, files.length)) < 2) break shardedRun; // ordinary runs shard over the slots free after landings [C7]
        const inherited = scopedMarker ? inheritedGateSlot({ root: process.cwd(), browser }) : null; const { runLandingShards } = await services.landing();
        const { parseProcessCensus } = await import('../../../kernel/index.js');
        const { browserBoundFiles } = await import('./browser/admission.js');
        // One read of each planned file's first-line declaration, shared by every shard [C7].
        const browserBound = browserBoundFiles(process.cwd(), files).then(bound => new Set(bound));
        const result = await runLandingShards({ root: process.cwd(), runner, files, count, inherited, fullScope: fullSuite && !narrowsSelection(actions.args, optionTakesValue), parseProcessCensus, args: (nativeFileArguments(actions.args, { files: Infinity }, knownNodeOption, optionTakesValue), landingShardOptions(actions.args, optionTakesValue)), // The unsharded parser's refusals, then every option as written.
          runnerAdmission: { ...runnerAdmission, runnerOnly },
          needsBrowser: async shardFiles => { const bound = await browserBound; return shardFiles.some(file => bound.has(file)); }, timing });
        timing.sharded(result, files);
        process.exitCode = result.isGreen ? 0 : 1;
        return;
      }
    }
    if (scopedMarker) {
      const inherited = inheritedGateSlot({ root: process.cwd(), browser, namedFiles: shortEligible });
      if (inherited && (!runnerOnly || inherited.runnerExecution)) await run(gateSlotEnvironment(inherited));
      else await acquire();
    } else if (legacyHeld) {
      throw new Error('this legacy gate marker does not identify a live machine gate lease; restart the parent runner with a scoped gate lease');
    } else await acquire();

    /** Acquire all required capabilities before creating the sandbox or starting test processes. */
    async function acquire() {
      // Direct runs use the public queue, requesting gate and browser capacity atomically when needed.
      // Gate slot and services by direct file: the gate, runner and landing front doors reach gate.js, board and machine [C7,V4].
      const [{ withGateSlot }, { loadMachineSettings }, { gateSlotServices }] = await Promise.all([
        import('./slot.js'), import('../../../config/index.js'), services.gateSlotServices(),
      ]);
      const executionServices = await gateSlotServices();
      const capacity = loadMachineSettings().gateSlots;
      const { timingSeat } = await import('../../../seats/light.js');
      const seat = timingSeat(process.cwd());
      let announced = false;
      const runnerPath = relative(process.cwd(), runner);
      const canShipRunner = runnerPath && runnerPath !== '..' && !runnerPath.startsWith(`..${sep}`);
      if (runnerOnly && !canShipRunner) throw new Error('Runner-only tests require a committed runner inside the checkout; no local fallback is allowed');
      await withGateSlot(process.cwd(), async (lease) => {
        if (!lease.runner) return run(gateSlotEnvironment(lease));
        const { runOnRunner } = await services.runners();
        /** Quote the unchanged runner arguments for the remote command shell. */
        const word = value => `'${String(value).replaceAll("'", "'\\''")}'`;
        const command = ['node', `./${runnerPath}`, ...actions.args].map(word).join(' ');
        timing.forward(); clock.mark('admission');
        const result = runOnRunner(process.cwd(), command, { runner: lease.runner, source: lease.source,
          browser, metadata: lease.runMetadata }); clock.mark('runner');
        process.stdout.write(result.output);
        process.exitCode = result.exitCode;
      }, {
        executionServices, browser, gui,
        kind: process.env[LANDING_RUN_ENV] === '1' ? 'gate' : 'seat-test', agent: seat?.seat,
        // A run the landing worker spawns (a main comparison, a bisection half) waits as a landing, not as a seat test
        // behind every submit: one comparison queued 17 minutes behind builders on 6 Nov while nothing landed [C7].
        landing: process.env.PULLBOARD_LANDING_CLASS === '1',
        shortEligible,
        ...runnerAdmission, remote: Boolean(canShipRunner), runnerOnly,
        onWait: state => {
          recordRunnerWait(state);
          const { holders, runnerUnavailable } = state;
          if (state.admitted) return;
          if (runnerUnavailable) {
            process.stderr.write(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; requeueing the run\n`);
            return;
          }
          if (announced) return;
          announced = true;
          process.stderr.write(`waiting for a gate slot: ${holders.length} of ${capacity} in use\n`);
        },
      });
    }
  } catch (error) {
    process.stderr.write(`run-tests: ${error.message}\n`);
    process.exitCode = error.neverRanExitCode ?? 1; // A run stopped before it started exits distinctly, never as a red.
    return;
  }
  if (signal) process.kill(process.pid, signal);
}

/**
 * Run the test runner as the launcher's process: the controller when the launcher is the entry file, else the preload of one test file.
 * Why: the engine lives in gate, which sits below landing and runners, so the launcher passes their loaders in.
 * @param {{ runner: string, services: { landing: () => Promise<object>, runners: () => Promise<object>, gateSlotServices: () => Promise<object> } }} launcher
 * @returns {Promise<void>}
 */
export async function startRunTests(launcher) {
runner = launcher.runner;
services = launcher.services;
if (process.argv[1] && resolve(process.argv[1]) === runner) {
  // No test run starts on the coordinator unless a runner job started it (#3899).
  (await import('./coordinator/guard.js')).refuseTestsOnCoordinator({ read: (await import('../../../config/index.js')).loadMachineSettings });
  const { beginSeatTiming } = await import('../../../seats/light.js');
  const finishSeatTiming = beginSeatTiming(process.cwd(), 'test', 'run-tests');
  let finishWait;
  recordRunnerWait = state => { if (state.admitted) { finishWait?.(); finishWait = null; } else finishWait ??= beginSeatTiming(process.cwd(), 'runner-wait', 'gate slot'); };
  try { await main(process.argv.slice(2)); } finally { finishWait?.(); finishSeatTiming(); }
} else if (process.argv[1]) {
  process.env.PULLBOARD_TEST_FILE = process.argv[1];
  (await import('./test/action/cache.js')).recordTestAction(process.argv[1]); // #1045: reuse off below; record this file.
  const fileTimes = process.env[LANDING_FILE_TIMES_ENV];
  let tokenWaitMs = 0;
  // Only this test file reports; anything it starts is not one of the shard's files.
  delete process.env[LANDING_FILE_TIMES_ENV];
  if (fileTimes && process.env.NODE_TEST_CONTEXT === 'child-v8') {
    // One line per test file process: its wall time from start to exit, for the next shard plan.
    const timedFile = relative(process.cwd(), resolve(process.argv[1]));
    process.once('exit', () => {
      // The file's own time, not its wait for a token: the next shard plan weighs work, not this run's queue (#1046).
      try { appendFileSync(fileTimes, `${JSON.stringify({ file: timedFile, ms: Math.round(process.uptime() * 1000 - tokenWaitMs) })}\n`); }
      catch { /* A missing time only weakens the next shard plan. */ }
    });
  }
  const startsPath = process.env[LANDING_WORKER_STARTS_ENV];
  const attempt = process.env[LANDING_ATTEMPT_ENV];
  const landingWorker = Boolean(startsPath && attempt);
  let cleanupWatchdog;
  if (landingWorker) {
    // Preserve #589 timing/custody behavior and announce before any browser-capacity wait.
    cleanupWatchdog = installTestWatchdog();
    const file = resolve(process.argv[1]);
    let identityAvailable = false;
    appendFileSync(startsPath, `${JSON.stringify({ type: 'worker-pending', attempt, file,
      pid: process.pid, parentPid: process.ppid })}\n`);
    try {
      const identity = await landingWorkerIdentity(process.pid);
      appendFileSync(startsPath, `${JSON.stringify({ type: 'worker', attempt, file,
        pid: identity.pid, pgid: identity.pgid, started: identity.started })}\n`);
      identityAvailable = true;
    } catch (error) {
      if (error.code === 'LANDING_CANCELLED') throw error;
      const code = error.cause?.code ?? error.code ?? 'snapshot-error';
      const reason = String(error.cause?.message ?? error.message ?? error)
        .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 512);
      appendFileSync(startsPath, `${JSON.stringify({ type: 'worker-identity-unavailable', attempt, file,
        pid: process.pid, parentPid: process.ppid, code, reason })}\n`);
      process.stderr.write(`run-tests: worker identity unavailable (${code}): ${reason}\n`);
    }
    if (identityAvailable) watchLandingChildSpawns(startsPath, attempt, file);
    else watchLandingChildCustody(startsPath, attempt);
  }
  if (process.env.PULLBOARD_TEST_BROWSER_RESOURCE && process.env.NODE_TEST_CONTEXT === 'child-v8'
      && !process.env.PULLBOARD_TEST_BROWSER_OWNER_PID) {
    // The worker is announced to #589 before it can wait here; admission remains before file import/body.
    process.env.PULLBOARD_TEST_BROWSER_OWNER_PID = String(process.pid);
    // The test body never sees the setting itself; the file's first-line declaration alone decides its lease [C7].
    delete process.env.PULLBOARD_TEST_BROWSER_BY_LAUNCH;
    const { testsNeedBrowser } = await import('./browser/admission.js');
    if (await testsNeedBrowser(process.cwd(), [process.argv[1]])) {
      const { takeResource } = await import('../../../resources/index.js');
      const lease = await takeResource({ name: process.env.PULLBOARD_TEST_BROWSER_RESOURCE,
        capacity: Number(process.env.PULLBOARD_TEST_BROWSER_CAPACITY), kind: 'test-browser-file', root: process.cwd() });
      // Hold through file cleanup and process exit, including abort/watchdog paths.
      process.once('exit', () => lease.release());
      process.env.PULLBOARD_TEST_BROWSER_SLOT = 'held';
    } else {
      // Undeclared: any browser spawn from this file or a Node child it starts is refused by name (BROWSER_UNDECLARED).
      process.env.PULLBOARD_TEST_BROWSER_SLOT = 'none';
      const guard = new URL('./browser/guard.js', import.meta.url);
      await import(guard.href);
      process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${guard.href}`].filter(Boolean).join(' ');
    }
  }
  // After any browser wait, so a file never holds a core while it queues for a browser (#1046).
  if (process.env.NODE_TEST_CONTEXT === 'child-v8') tokenWaitMs = await takeTestFileToken();
  reportFileTest = installFileWatchdog(process.argv[1]);
  if (!landingWorker) cleanupWatchdog = installTestWatchdog();
  if (process.env.NODE_TEST_CONTEXT === 'child-v8') installTestChildDrain({
    sandbox: process.env.PULLBOARD_TEST_SANDBOX, timeoutMs: testFileTimeoutMs(),
    onStart: cleanupWatchdog.pause, onEnd: cleanupWatchdog.resume,
  });
}
}
