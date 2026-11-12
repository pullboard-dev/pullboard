import { commandPhaseSnapshot } from '../../../../../packages/link/index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../../packages/kernel/index.js';
/** Private real CLI, auth and relay fixture; credentials never enter assertion messages [H1,H7,H18]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  startFixtureChild as spawn,
  reportFixtureChildFailure,
  runFixtureChild,
} from '../child.js';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { stopSender } from './sender.js';
import { runCliInProcess } from '../process.js';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
  resolve,
  relative,
  sep,
} from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { relayServerFixture } from '../../../../relay/tests/fixtures/relay-server-fixture.js';
import {
  relayWorkBudgetMs,
  MAX_SNAPSHOT_ATTEMPTS,
} from './budget.js';

const CLI = resolve(import.meta.dirname, '../../../pullboard.js');
const MAX_OBSERVED_SNAPSHOT_UPLOADS = MAX_SNAPSHOT_ATTEMPTS;
const DEFAULT_SNAPSHOT_UPLOADS = 3;
// One former whole-snapshot wire allowance is a finite unit of observed API2 transfer work too.
const PAGE_WORK_BYTES = 10_000_000;

/** Keep legacy attempts exact while counting received API2 wire bytes and checkpoint attempts, never elapsed activity. */
function uploadWork(value) {
  const work = typeof value === 'number' ? { legacyUploads: value } : value;
  const result = Object.fromEntries(['legacyUploads', 'pageUploadBytes', 'pageSessions', 'pageCheckpointAttempts'].map(key => [key, work?.[key] ?? 0]));
  assert.ok(Object.values(result).every(number => Number.isSafeInteger(number) && number >= 0), 'fixture upload work has bounded integer counters');
  result.units = result.legacyUploads + Math.max(result.pageSessions, result.pageCheckpointAttempts) + Math.ceil(result.pageUploadBytes / PAGE_WORK_BYTES);
  // Attempt and byte ceilings are independent: bytes do not consume a checkpoint attempt. Time still has the released six-unit cap.
  result.budgetUnits = Math.min(result.units, MAX_OBSERVED_SNAPSHOT_UPLOADS);
  result.overLimit = result.legacyUploads > MAX_OBSERVED_SNAPSHOT_UPLOADS || result.pageSessions > MAX_OBSERVED_SNAPSHOT_UPLOADS
    || result.pageCheckpointAttempts > MAX_OBSERVED_SNAPSHOT_UPLOADS || result.pageUploadBytes > PAGE_WORK_BYTES * MAX_OBSERVED_SNAPSHOT_UPLOADS;
  return result;
}


/** Derive a private CLI child deadline from observed uploads, with a finite runaway guard. */
export function cliChildDeadlineMs(observedUploads) {
  assert.ok(Number.isSafeInteger(observedUploads) && observedUploads >= 0 && observedUploads <= MAX_OBSERVED_SNAPSHOT_UPLOADS,
    'observed snapshot upload count is within the finite fixture bound');
  return relayWorkBudgetMs(observedUploads);
}

/** Count exact checkpoints; a newer acknowledged snapshot may cover a superseded timeout. */
export function assertSnapshotCheckpoints(trace, expected) {
  try {
    const checkpoints = new Map();
    let priorSequence = -1;
    for (const write of trace) {
      assert.ok(Number.isSafeInteger(write.sequence) && /^[0-9a-f]{64}$/u.test(write.ciphertext ?? ''), 'checkpoint metadata is complete');
      assert.ok(write.sequence >= priorSequence, 'checkpoint attempts never regress the covered sequence');
      priorSequence = write.sequence;
      const previous = checkpoints.get(write.sequence);
      if (previous) {
        assert.equal(write.ciphertext, previous.ciphertext, 'a retried sequence preserves its exact ciphertext');
        assert.equal(previous.abort?.name, 'TimeoutError', 'only a timed-out PUT can add a transport attempt');
        // Bind the exported retry function, independent of its source module or namespace.
        assert.ok(write.callers.some(caller => caller.split('@', 1)[0].replace(/^async /u, '').split('.').at(-1) === 'retrySync'),
          'syncRelay retries the persisted checkpoint');
      }
      checkpoints.set(write.sequence, write);
    }
    assert.equal(checkpoints.size, expected, 'the flow publishes its exact number of distinct checkpoints');
    if (expected === 0) return checkpoints.size;
    const latest = trace.at(-1);
    assert.equal(latest?.status, 200, 'the latest checkpoint receives an acknowledgement');
    for (const write of checkpoints.values()) {
      if (write.status === 200) continue;
      assert.equal(write.abort?.name, 'TimeoutError', 'only a timed-out checkpoint can be superseded');
      assert.ok(latest.sequence > write.sequence, 'the acknowledged checkpoint covers the superseded sequence');
    }
    return checkpoints.size;
  } catch (error) {
    error.message += '; sanitized checkpoint fetches: ' + JSON.stringify(trace);
    throw error;
  }
}

/** Capture a real child result without exposing its private output in failure diagnostics. */
function childResult(root, env, argv, observedSnapshotUploads, initialSnapshotUploads = DEFAULT_SNAPSHOT_UPLOADS) {
  return new Promise((resolveResult, reject) => {
    const startedAt = performance.now();
    let deadlineMs = cliChildDeadlineMs(initialSnapshotUploads);
    let work = uploadWork(initialSnapshotUploads);
    const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let exceededDeadline = false;
    let exceededWork = false;
    let settled = false;
    const timer = setInterval(() => {
      work = uploadWork(observedSnapshotUploads?.() ?? initialSnapshotUploads);
      if (work.overLimit) {
        exceededWork = true;
        child.kill('SIGKILL');
        return;
      }
      deadlineMs = Math.max(deadlineMs, cliChildDeadlineMs(work.budgetUnits));
      if (performance.now() - startedAt >= deadlineMs) { exceededDeadline = true; child.kill('SIGKILL'); }
    }, 20);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
    /** Retain the exact command and work-derived bound without exposing credentials. */
    const reportFailure = (code, signal, detail = '') => reportFixtureChildFailure({
      command: process.execPath, args: argv, status: code, signal,
      elapsedMs: performance.now() - startedAt, stderr, env, detail: exceededDeadline
        ? detail + '\nstall phase capture: ' + JSON.stringify(commandPhaseSnapshot(env.PULLBOARD_COMMAND_PHASE_FILE, child.pid)) : detail,
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      reject(new Error(reportFailure(null, null, error.message)));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      const phase = work.pageUploadBytes > 0 ? 'API2 page upload' : work.pageSessions || work.pageCheckpointAttempts ? 'API2 checkpoint' : 'snapshot upload';
      if (signal) return reject(new Error(reportFailure(code, signal, exceededWork
        ? `declared upload work limit exceeded: at most ${MAX_OBSERVED_SNAPSHOT_UPLOADS} attempts and ${PAGE_WORK_BYTES * MAX_OBSERVED_SNAPSHOT_UPLOADS} page bytes; recorded work ${JSON.stringify(work)}`
        : exceededDeadline ? `${phase} stalled: upload-derived child deadline ${deadlineMs}ms exceeded; recorded work ${JSON.stringify(work)}` : '')));
      const failure = code === 0 ? null : reportFailure(code, signal);
      let document;
      try { document = JSON.parse(stdout); }
      catch (error) { return reject(new Error(reportFailure(code, signal, `private relay fixture child did not return JSON: ${error.message}`))); }
      work = uploadWork(observedSnapshotUploads?.() ?? initialSnapshotUploads);
      resolveResult({ code, document, failure, snapshotUploads: work.legacyUploads,
        snapshotWork: { ...work, observed: typeof observedSnapshotUploads === 'function' }, snapshotDeadlineMs: deadlineMs });
    });
  });
}

/**
 * Run the production CLI in this process with the same result shape as childResult. The loopback relay shares
 * this event loop and the command is awaited, so it answers while the command runs; a stalled command fails at
 * the same upload-derived deadline instead of being killed, because a process cannot kill itself safely.
 * Callers that need a real process (the fetch-trace preload, live streams, signals) keep childResult [C7].
 */
async function inProcessResult(root, env, args, observedSnapshotUploads, initialSnapshotUploads = DEFAULT_SNAPSHOT_UPLOADS) {
  const startedAt = performance.now();
  const argv = [...args, '--json'];
  let deadlineMs = cliChildDeadlineMs(initialSnapshotUploads);
  let work = uploadWork(initialSnapshotUploads);
  let timer;
  let finished = false;
  const stalled = new Promise((_, reject) => {
    /** Re-check the observed work, then re-arm one short timer until the command settles. */
    const check = () => {
      if (finished) return;
      work = uploadWork(observedSnapshotUploads?.() ?? initialSnapshotUploads);
      if (work.overLimit) return reject(new Error(`declared upload work limit exceeded; recorded work ${JSON.stringify(work)}`));
      deadlineMs = Math.max(deadlineMs, cliChildDeadlineMs(work.budgetUnits));
      if (performance.now() - startedAt >= deadlineMs) return reject(new Error(`in-process command stalled: upload-derived deadline ${deadlineMs}ms exceeded; recorded work ${JSON.stringify(work)}`));
      timer = setTimeout(check, 20);
    };
    timer = setTimeout(check, 20);
  });
  stalled.catch(() => {});
  let run;
  try { run = await Promise.race([runCliInProcess(argv, { cwd: root, env }), stalled]); }
  finally { finished = true; clearTimeout(timer); }
  const report = (detail = '') => reportFixtureChildFailure({ command: process.execPath, args: ['in-process', ...argv], status: run.code, signal: null,
    elapsedMs: performance.now() - startedAt, stderr: run.stderr, env, detail });
  let document;
  try { document = JSON.parse(run.stdout); }
  catch (error) { throw new Error(report(`private relay fixture command did not return JSON: ${error.message}; stdout tail: ${JSON.stringify(run.stdout.slice(-400))}`)); }
  work = uploadWork(observedSnapshotUploads?.() ?? initialSnapshotUploads);
  deadlineMs = Math.max(deadlineMs, cliChildDeadlineMs(work.budgetUnits));
  return { code: run.code, document, failure: run.code === 0 ? null : report(), snapshotUploads: work.legacyUploads,
    snapshotWork: { ...work, observed: typeof observedSnapshotUploads === 'function' }, snapshotDeadlineMs: deadlineMs };
}

export { childResult as relayFixtureChild };

/**
 * Start an isolated board and authorized loopback relay; a null coordinatorModel keeps its initial identity unknown.
 * The relay polls each live stream at its production 200 ms. Each poll opens the board journals, and at the 10 ms this
 * fixture once used, a loaded machine kept the test process busy enough that browser replies queued past their
 * deadlines (#955, #979). A case that needs a faster poll passes pollMs by name and says why.
 */
export async function relayClientFixture(t, { cliChildren, coordinatorModel, accountStorageBytes, pollMs = 200, host = '127.0.0.1' } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-cleanup-')));
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const privateBin = join(scratch, 'path');
  const hookBin = join(scratch, 'hook-path');
  const traceFile = join(scratch, 'snapshot-fetch-trace.jsonl');
  const tracePreload = join(scratch, 'snapshot-fetch-trace.mjs');
  mkdirSync(root);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(privateBin, { mode: 0o700 });
  mkdirSync(hookBin, { mode: 0o700 });
  const git = process.env.PATH.split(delimiter).map(entry => join(entry, 'git')).find(existsSync);
  assert.ok(git, 'fixture has a git executable');
  symlinkSync(realpathSync(git), join(privateBin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(privateBin, 'node'));
  symlinkSync(realpathSync(CLI), join(hookBin, 'pullboard'));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(scratch, 'machine'), PATH: privateBin,
    TERM_SESSION_ID: createHash('sha256').update(scratch).digest('hex'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'relay-fixture@example.com',
    GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'relay-fixture@example.com',
  };
  if (coordinatorModel === null) delete env.PULLBOARD_MODEL;
  else if (coordinatorModel !== undefined) env.PULLBOARD_MODEL = coordinatorModel;
  writeFileSync(tracePreload, `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const originalFetch = globalThis.fetch;
/** Record safe request, caller and checkpoint details for this private relay only. */
globalThis.fetch = function tracedFetch(input, init) {
  const target = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
  const method = init?.method ?? input?.method ?? 'GET';
  if (target.origin !== process.env.PULLBOARD_TEST_RELAY_TRACE_ORIGIN || method !== 'PUT'
      || !/^\\/api\\/v1\\/boards\\/[0-9a-f]{32}\\/state$/u.test(target.pathname)) {
    return originalFetch.call(this, input, init);
  }
  const startedAt = Date.now();
  const body = init?.body;
  let sequence = null;
  let ciphertext = null;
  try {
    const document = JSON.parse(String(body));
    if (Number.isSafeInteger(document.sequence)) sequence = document.sequence;
    if (typeof document.sealed === 'string') ciphertext = createHash('sha256').update(document.sealed).digest('hex');
  } catch { /* Record only metadata for malformed fixture traffic. */ }
  const callers = (Error.stackTraceLimit = 64, new Error().stack ?? '').split('\\n')
    .filter(line => line.includes('/src/'))
    .slice(0, 32)
    .map(line => {
      const name = line.match(/^\\s*at (.*?) \\(/u)?.[1] ?? '<anonymous>';
      const location = line.match(/\\/src\\/((?:[^/():]+\\/)*[^/():]+\\.js:\\d+:\\d+)/u)?.[1] ?? 'unknown';
      return name + '@' + location;
    });
  const signal = init?.signal ?? input?.signal;
  let abort = signal?.aborted ? { at: Date.now(), name: signal.reason?.name ?? null, code: signal.reason?.code ?? null } : null;
  const onAbort = () => { abort = { at: Date.now(), name: signal.reason?.name ?? null, code: signal.reason?.code ?? null }; };
  signal?.addEventListener('abort', onAbort, { once: true });
  const record = { at: startedAt, method, path: target.pathname.replace(/\\/[0-9a-f]{32}\\//u, '/<board>/'), sequence, ciphertext, callers };
  /** Persist one bounded request outcome while excluding the sealed payload and credentials. */
  function finish(details) {
    appendFileSync(process.env.PULLBOARD_TEST_RELAY_TRACE_FILE, JSON.stringify({ ...record, abort, ...details }) + '\\n', { mode: 0o600 });
    signal?.removeEventListener('abort', onAbort);
  }
  return originalFetch.call(this, input, init).then(response => {
    finish({ status: response.status, elapsedMs: Date.now() - startedAt });
    return response;
  }, error => {
    finish({ errorName: error.name, errorCode: error.code ?? null, elapsedMs: Date.now() - startedAt });
    throw error;
  });
};
`, { mode: 0o600 });
  writeFileSync(traceFile, '', { mode: 0o600 });
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN', ...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  const srv = await relayServerFixture(t, { accountStorageBytes, pollMs, host, scratch, beforeClose: () => stopSender(root) });
  const { provider, privateKeys, pageWork, snapshotWriteLog, snapshotWriteCountNow, origin, auth, authDatabase, ...serverApi } = srv;
  /** Invoke the production CLI in this private repository. */
  let cliChildIndex = 0;
  let phaseSequence = 0;
  /** Verify and consume the next optional test-flow child descriptor. */
  function plannedSnapshotUploads(args) {
    if (!cliChildren) return undefined;
    const step = cliChildren[cliChildIndex++];
    assert.ok(step, `unexpected private CLI child: ${args.slice(0, 2).join(' ')}`);
    assert.deepEqual(args.slice(0, step.command.length), step.command, `private CLI child ${cliChildIndex} matches its budget descriptor`);
    return step.snapshotUploads;
  }
  /** Run one CLI child and verify its observed uploads against the plan when the test supplied one. */
  async function runCliChild(args, requestedUploads, traceSnapshotWrites = false) {
    const plannedUploads = plannedSnapshotUploads(args);
    const snapshotUploads = plannedUploads ?? requestedUploads;
    const writesBefore = snapshotWriteCountNow();
    const pagesBefore = { ...pageWork };
    /** Observe only this child's received work; retries consume the same finite six-unit allowance. */
    const observedWork = () => ({ legacyUploads: snapshotWriteCountNow() - writesBefore,
      ...Object.fromEntries(Object.entries(pageWork).map(([name, count]) => [name, count - pagesBefore[name]])) });
    const phaseEnv = { ...env, PULLBOARD_COMMAND_PHASE_FILE: join(scratch, `command-phase-${++phaseSequence}.jsonl`) };
    const childEnv = traceSnapshotWrites ? { ...phaseEnv, PULLBOARD_TEST_RELAY_TRACE_FILE: traceFile,
      PULLBOARD_TEST_RELAY_TRACE_ORIGIN: origin,
      NODE_OPTIONS: [env.NODE_OPTIONS, '--import=' + pathToFileURL(tracePreload).href].filter(Boolean).join(' ') } : phaseEnv;
    const traceLinesBefore = traceSnapshotWrites ? readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).length : 0;
    const initialUploads = traceSnapshotWrites ? 0 : snapshotUploads ?? DEFAULT_SNAPSHOT_UPLOADS;
    /** Read only this child’s sanitized fetch records, retaining evidence before fixture cleanup. */
    function childTrace() {
      if (!traceSnapshotWrites) return [];
      return readFileSync(traceFile, 'utf8').split('\n').filter(Boolean)
        .slice(traceLinesBefore).map(line => JSON.parse(line));
    }
    let result;
    try {
      result = traceSnapshotWrites ? await childResult(root, childEnv, [CLI, ...args, '--json'], observedWork, initialUploads)
        : await inProcessResult(root, childEnv, args, observedWork, initialUploads);
    } catch (error) {
      if (traceSnapshotWrites) {
        const evidence = JSON.stringify({ fetches: childTrace(), relayReceives: snapshotWriteLog.slice(writesBefore), uploadWork: observedWork() });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; safe snapshot transport evidence: ${evidence}`, { cause: error });
      }
      throw error;
    }
    if (traceSnapshotWrites) result.snapshotTrace = childTrace();
    if (cliChildren) {
      const observedUploads = snapshotWriteCountNow() - writesBefore;
      const observedWrites = snapshotWriteLog.slice(writesBefore);
      const safeTrace = result.snapshotTrace ?? [];
      try {
        if (traceSnapshotWrites) assertSnapshotCheckpoints(safeTrace, snapshotUploads);
        else assert.equal(observedUploads, snapshotUploads, 'untraced setup uploads match the plan');
      } catch (error) {
        error.message += `; private CLI child ${cliChildIndex}; client fetches: ${JSON.stringify(safeTrace)}; relay receives: ${JSON.stringify(observedWrites)}`;
        throw error;
      }
    }
    if (cliChildren && requestedUploads !== undefined) {
      assert.equal(requestedUploads, snapshotUploads, `private CLI child ${cliChildIndex} uses its declared upload count`);
    }
    return result;
  }
  /** Invoke the production CLI in this private repository under its planned budget, when present. */
  async function cli(...args) {
    return runCliChild(args, undefined, args[0] === 'status');
  }
  /** Invoke the production CLI in-process under the same budget; the answer is the childResult shape without a fetch trace. */
  async function cliLocal(...args) {
    return runCliChild(args, undefined, false);
  }
  /** Invoke the production CLI in-process from another worktree sharing this fixture's repository and home. */
  async function cliAtLocal(cwd, ...args) {
    return inProcessResult(cwd, env, args);
  }
  /** Invoke the production CLI from another worktree sharing this fixture's repository and home. */
  async function cliAt(cwd, ...args) {
    return inProcessResult(cwd, env, args);
  }
  /** Bound a CLI child using the exact snapshot count asserted by its fixture flow. */
  async function cliWithSnapshotUploads(snapshotUploads, ...args) {
    cliChildDeadlineMs(snapshotUploads);
    return runCliChild(args, snapshotUploads, args[0] === 'status');
  }
  /** Run a CLI child with sanitized local snapshot callsite tracing for diagnosis. */
  async function cliWithSnapshotTrace(snapshotUploads, ...args) {
    cliChildDeadlineMs(snapshotUploads);
    return runCliChild(args, snapshotUploads, true);
  }
  /** Start live CLI output; raw mode also preserves the foreground wait for an already-paired phone's link tap. */
  function startCli(args, extraEnv = {}, { json = true } = {}) {
    const child = spawn(process.execPath, [CLI, ...args, ...(json ? ['--json'] : [])], { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const deadlineMs = cliChildDeadlineMs(DEFAULT_SNAPSHOT_UPLOADS);
    /** Stop a private CLI process that exceeds the fixture's upload-derived ceiling. */
    function stopOverdueChild() { child.kill('SIGKILL'); }
    const watchdog = setTimeout(stopOverdueChild, deadlineMs);
    watchdog.unref?.();
    /** Retain streamed standard output for the final machine-readable result. */
    function captureStdout(part) { stdout += part; }
    /** Retain streamed standard error so the browser can follow the printed confirmation URL. */
    function captureStderr(part) { stderr += part; }
    child.stdout.setEncoding('utf8').on('data', captureStdout);
    child.stderr.setEncoding('utf8').on('data', captureStderr);
    /** Preserve a single terminal result for both output waiters and fixture cleanup. */
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    /** Capture child exit without losing stdout or stderr already delivered to this fixture. */
    function onClose(code, signal) {
      clearTimeout(watchdog);
      resolveClosed({ code, signal, stdout, stderr });
    }
    child.once('close', onClose);
    /** Reject prompt waits when the child closes before the expected text appears. */
    function failClosed() { throw new Error('private CLI closed before its expected prompt'); }
    /** Wait for a specific streamed prompt, or fail when the child exits before printing it. */
    async function waitForOutput(marker) {
      while (!stderr.includes(marker)) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('private CLI exited before its expected prompt');
        await Promise.race([once(child.stderr, 'data'), closed.then(failClosed)]);
      }
      return stderr;
    }
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await closed;
    });
    return { child, closed, deadlineMs, waitForOutput, get stdout() { return stdout; }, get stderr() { return stderr; } };
  }
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  writeFileSync(join(root, 'README.md'), 'private relay fixture project\n', { mode: 0o600 });
  assert.equal(runFixtureChild('git', ['add', 'README.md'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  assert.equal(runFixtureChild('git', ['commit', '-q', '-m', 'fixture base'], { cwd: root, env, encoding: 'utf8' }).status, 0, 'fixture clone starts from a committed project');
  assert.equal((await cli('init')).code, 0);
  // Waiver signing is guarded by committed coordinator policy before it reaches the person-signing check [E22].
  const policyPath = join(root, 'pullboard.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  writeFileSync(policyPath, JSON.stringify({ ...policy, landing: { ...policy.landing, manualOverride: true } }, null, 2) + '\n');
  assert.equal(runFixtureChild('git', ['add', 'pullboard.json'], { cwd: root, env, encoding: 'utf8' }).status, 0, 'initialized coordinator policy is staged');
  const policyCommit = runFixtureChild('git', ['commit', '-q', '-m', 'test(relay): commit initialized coordinator policy'], {
    cwd: root, env: { ...env, PATH: `${hookBin}:${env.PATH}` }, encoding: 'utf8' });
  assert.equal(policyCommit.status, 0, policyCommit.failure ?? policyCommit.stderr + policyCommit.stdout);
  assert.equal(runFixtureChild('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  const lane = Object.keys(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes)[0];
  assert.equal((await cli('add', lane, 'private cleanup fixture item')).code, 0);
  const before = (await cli('export')).document;
  const id = before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const keyFile = join(env.PULLBOARD_HOME, 'relay-keys', id + '.key');

  /** Read this fixture's immutable local link path with the original raw UTF-8 and failure semantics. */
  function readLink() {
    return readFileSync(linkFile, 'utf8');
  }

  /** Read this fixture's same immutable key path; callers retain their original decoding and missing-file failures. */
  function readKey() {
    return readFileSync(keyFile, 'utf8');
  }

  /** Require the actual constructor-owned scratch origin, including every existing ancestor. */
  function privateDirectory(directory, missing = false) {
    const path = resolve(directory);
    assert.ok(path.startsWith(scratch + sep), 'private input stays inside this fixture origin');
    let cursor = scratch;
    for (const part of relative(scratch, path).split(sep)) {
      cursor = join(cursor, part);
      let stat;
      try { stat = lstatSync(cursor); }
      catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'private input ancestors are actual directories');
    }
    return path;
  }

  /** Copy this actual private board metadata, preserving the original lock exclusion and every other byte. */
  function copyOwnBoardMetadata(destinationRoot) {
    privateDirectory(join(root, '.git', 'pullboard'));
    privateDirectory(join(destinationRoot, '.git'));
    privateDirectory(join(destinationRoot, '.git', 'pullboard'), true);
    cpSync(join(root, '.git', 'pullboard'), join(destinationRoot, '.git', 'pullboard'),
      { recursive: true, filter: path => !path.endsWith('.lock') });
  }

  /** Copy only this board's actual key to another private home; an unknown board cannot borrow the capability. */
  function copyOwnKey(destinationHome, boardId) {
    assert.match(boardId, /^[a-f0-9]{32}$/u, 'private key destination names a canonical board');
    assert.equal(boardId, id, 'private key belongs to exactly this fixture board');
    privateDirectory(join(destinationHome, 'relay-keys'));
    const source = lstatSync(keyFile);
    assert.ok(source.isFile() && !source.isSymbolicLink() && realpathSync(keyFile).startsWith(scratch + sep), 'private key source is its actual contained regular file');
    const target = join(destinationHome, 'relay-keys', boardId + '.key');
    try { const stat = lstatSync(target); assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'private key destination is a regular file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    cpSync(keyFile, target);
  }

  /** Audit every recursive file Buffer under a private origin, without filtering source or metadata subtrees. */
  function privateTreeBytes(directory) {
    const path = privateDirectory(directory, true);
    if (path === null) return [];
    /** Keep the original all-file traversal; an escaping link fails rather than disappearing from coverage. */
    function readAll(current) {
      return readdirSync(current, { withFileTypes: true }).flatMap(entry => {
        const file = join(current, entry.name);
        if (entry.isDirectory()) return readAll(file);
        assert.ok(realpathSync(file).startsWith(scratch + sep), 'private audit cannot read an escaping symlink');
        return [readFileSync(file)];
      });
    }
    return readAll(path);
  }

  /** Start a saved real relay link without exposing the pairing fragment. */
  async function link(name) {
    const result = await cli('relay', 'on', '--url', origin, ...(name === undefined ? [] : ['--name', name]));
    assert.equal(result.code, 0, 'real device sign-in links the board');
    privateKeys.add(readKey().trim());
    return result;
  }
  /** Raise this fixture board's durable minimum to the current engine before compatibility checks. */
  async function requireEngineThree() {
    const state = JSON.parse(readLink());
    await auth.issueToken(state.token, { board: state.board, agent: 'fixture-engine-minimum' });
    return auth.minimumEngineVersion(state.board);
  }
  /** Pair and unlink from a second real repository with its own private device home and key. */
  async function otherDeviceOff() {
    const otherRoot = join(scratch, 'other-device');
    const otherHome = join(scratch, 'other-home');
    mkdirSync(otherRoot);
    mkdirSync(otherHome, { mode: 0o700 });
    const otherEnv = { ...env, HOME: otherHome, PULLBOARD_HOME: join(otherHome, '.pullboard') };
    /** Invoke the independent device's production CLI without retaining its output in diagnostics. */
    const run = (...args) => childResult(otherRoot, otherEnv, [CLI, ...args, '--json']);
    assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: otherRoot, env: otherEnv, encoding: 'utf8' }).status, 0);
    assert.equal((await run('init')).code, 0);
    assert.equal(runFixtureChild('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv, encoding: 'utf8' }).status, 0);
    const snapshot = join(scratch, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify(before), { mode: 0o600 });
    assert.equal((await run('import', snapshot)).code, 0, 'second device imports the same real board');
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0, 'second device signs in independently');
    return (await run('relay', 'off')).code;
  }
  /** Clone the same committed project into a separate repository/home, then join through a printed code. */
  async function otherDeviceJoin(code, name) {
    const bare = join(scratch, 'project.git');
    const otherRoot = join(scratch, 'paired-clone');
    const otherHome = join(scratch, 'paired-home');
    mkdirSync(otherHome, { mode: 0o700 });
    const otherEnv = { ...env, HOME: otherHome, PULLBOARD_HOME: join(otherHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'paired-machine') };
    assert.equal(runFixtureChild('git', ['clone', '--bare', root, bare], { cwd: scratch, env: otherEnv, encoding: 'utf8' }).status, 0, 'fixture project creates a private bare remote');
    assert.equal(runFixtureChild('git', ['clone', bare, otherRoot], { cwd: scratch, env: otherEnv, encoding: 'utf8' }).status, 0, 'second device is a real clone');
    assert.equal(runFixtureChild('git', ['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv, encoding: 'utf8' }).status, 0, 'clone names the same authorized repository');
    const run = (...args) => childResult(otherRoot, otherEnv, [CLI, ...args, '--json']);
    const initEnv = { ...otherEnv };
    delete initEnv.PULLBOARD_MODEL; // Pairing imports the source coordinator's declaration.
    assert.equal((await childResult(otherRoot, initEnv, [CLI, 'init', '--json'])).code, 0, 'the cloned project initializes its private local board');
    const joined = await run('relay', 'join', code, '--url', origin, ...(name === undefined ? [] : ['--name', name]));
    const document = joined.document;
    if (joined.code !== 0) {
      const refusal = document?.error?.code;
      throw new Error(`real clone did not join the one-use pairing code (${typeof refusal === 'string' && /^[A-Z0-9_]+$/u.test(refusal) ? refusal : 'NO_TYPED_REFUSAL'})`);
    }
    const exported = await run('export');
    if (exported.code !== 0) throw new Error('paired clone could not read its restored board');
    const link = JSON.parse(readFileSync(join(otherRoot, '.git', 'pullboard', 'relay.json'), 'utf8'));
    const otherKeyFile = join(otherEnv.PULLBOARD_HOME, 'relay-keys', link.board + '.key');
    const environmentKey = readFileSync(otherKeyFile, 'utf8').trim();
    /** Run a real linked-clone command with only the environment key, after removing its key file. */
    async function syncWithEnvironmentKey(...args) {
      rmSync(otherKeyFile, { force: true });
      assert.equal(existsSync(otherKeyFile), false, 'the paired clone has no stored board-key file');
      const envKey = { ...otherEnv, PULLBOARD_RELAY_KEY: environmentKey };
      return childResult(otherRoot, envKey, [CLI, ...args, '--json']);
    }
    return { joined: document, machine: link.machine, exported: exported.document, cli: run, root: otherRoot, env: otherEnv, syncWithEnvironmentKey,
      /** Run a second-device worktree with that device's own keys and bounded asynchronous child. */
      cliAt(cwd, ...args) { return childResult(cwd, otherEnv, [CLI, ...args, '--json']); },
      /** Check that the paired clone still has no persisted board-key file. */
      keyFileExists() { return existsSync(otherKeyFile); } };
  }
  /** Link another independently initialized synthetic board through the same real person account. */
  async function additionalBoard(title, { sharedHome = false } = {}) {
    const nextRoot = mkdtempSync(join(scratch, 'additional-board-'));
    const nextHome = sharedHome ? home : mkdtempSync(join(scratch, 'additional-home-'));
    const nextEnv = { ...env, HOME: nextHome, PULLBOARD_HOME: join(nextHome, '.pullboard') };
    /** Run this separate board without retaining credentials in diagnostic output. */
    const run = (...args) => childResult(nextRoot, nextEnv, [CLI, ...args, '--json']);
    assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: nextRoot, env: nextEnv, encoding: 'utf8' }).status, 0);
    assert.equal((await run('init')).code, 0);
    // Its own repository: the relay links one team board per repository [E12].
    const repository = 'repository-' + (provider.state.repositories.length + 1);
    provider.state.repositories.push(repository);
    assert.equal(runFixtureChild('git', ['remote', 'add', 'origin', `git@github.com:fixture/${repository}.git`], { cwd: nextRoot, env: nextEnv, encoding: 'utf8' }).status, 0);
    assert.equal((await run('add', lane, title)).code, 0);
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0);
    const state = JSON.parse(readFileSync(join(nextRoot, '.git', 'pullboard', 'relay.json'), 'utf8'));
    const encoded = readFileSync(join(nextEnv.PULLBOARD_HOME, 'relay-keys', state.board + '.key'), 'utf8').trim();
    privateKeys.add(encoded);
    /** Run native fixture actions in this board's own home; no caller changes the parent process environment. */
    async function script(source) { return childResult(nextRoot, nextEnv, ['--input-type=module', '-e', source]); }
    return { id: state.board, encoded, cli: run, script };
  }
  /** Run multiple production commands in one process, emitting only safe counters. */
  async function script(source) {
    return childResult(root, env, ['--input-type=module', '-e', source]);
  }
  return {
    ...serverApi, authDatabase, auth, otherDeviceJoin,
    root, env, origin, lane, before, linkFile, readLink, keyFile, readKey, copyOwnBoardMetadata, copyOwnKey, privateTreeBytes, cli, cliAt, cliLocal, cliAtLocal, cliWithSnapshotUploads, cliWithSnapshotTrace, startCli, link, requireEngineThree, otherDeviceOff, additionalBoard, script,
    /** Assert the test consumed every declared child budget, with no hidden CLI calls. */
    assertCliChildrenComplete() {
      if (cliChildren) assert.equal(cliChildIndex, cliChildren.length, 'every planned private CLI child ran exactly once');
    },
    mainURL: new URL('../native.js', import.meta.url).href,
  };
}


/** Preserve explicit API1 wire-contract cases while the default fixture exercises current API2 writers. */
export async function legacyRelayClientFixture(t, options) {
  const box = await relayClientFixture(t, options);
  box.legacySnapshotApi();
  return box;
}
