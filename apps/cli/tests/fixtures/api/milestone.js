/** Shared fixtures for the milestone API journeys, split from one 250 s file so each runs under its budget [A2]. */
import { viewApiPorts } from '../api.js';
import { apiBoardOpeners } from '../board.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFixtureChild as spawn } from '../child.js';
import { reportFixtureChildFailure } from '../child.js';
import { safeFixtureDiagnostic } from '../child.js';
import { performance } from 'node:perf_hooks';
import { appendFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { main } from '../native.js';
import { fixtureSettledMachine } from '../testkit.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { runCliInProcess } from '../process.js';
import { createLocalApiHandler } from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { fixtureCommandEvidence } from '../api.js';
import { assertRequiredShape } from '../api.js';
import { json } from './project.js';
import { project } from './project.js';
import { shapeFor } from './project.js';
import { resolve } from 'node:path';

/** The CLI entry the serve child runs. */
export const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** Run the CLI in this process with the box's environment; same result shape as box.run, awaited [C7]. */
export const runLocal = (box, cwd, ...args) => runCliInProcess(args, { cwd, env: box.env });
/** Run a named CLI JSON step and retain its stdout, exit code and timing for assertions. */
export async function fixtureJsonStep(box, step, cwd, command, args = [], expectedStatus = 0, onEvidence) {
  const result = await runLocal(box, cwd, command, ...args, '--json');
  const evidence = fixtureCommandEvidence(step, result, box.env);
  onEvidence?.(evidence);
  assert.equal(result.status, expectedStatus, evidence);
  assert.equal(result.stderr, '', evidence);
  let document;
  try { document = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`${evidence}\ninvalid JSON: ${error.message}`); }
  assert.ok(document !== null && typeof document === 'object' && !Array.isArray(document),
    `${step} JSON response must be an object\n${evidence}`);
  assert.equal(document.version, 1, evidence);
  if (expectedStatus === 0) {
    assertRequiredShape(document, shapeFor(command).required, `${step} JSON\n${evidence}`);
  } else {
    assertRequiredShape(document, JSON_SHAPES.error.required, `${step} error JSON\n${evidence}`);
    assertRequiredShape(document.error, JSON_SHAPES.errorFields, `${step} error fields\n${evidence}`);
  }
  return { document, evidence };
}

/** Run one named API step and preserve its status, elapsed time and response body on failure. */
export async function apiStep(step, request, env, expectedStatus = 200) {
  const started = performance.now();
  let response;
  try { response = await request; }
  catch (error) { throw new Error(`${step}: HTTP request failed after ${Math.round(performance.now() - started)}ms; response unavailable: ${error.message}`, { cause: error }); }
  let body;
  try { body = await response.text(); }
  catch (error) { throw new Error(`${step}: HTTP ${response.status}; response body read failed after ${Math.round(performance.now() - started)}ms: ${error.message}`, { cause: error }); }
  const evidence = `${step}\nHTTP status: ${response.status}\nElapsed: ${Math.round(performance.now() - started)}ms\nBody: ${safeFixtureDiagnostic(body, env)}`;
  assert.equal(response.status, expectedStatus, evidence);
  let document;
  try { document = JSON.parse(body); }
  catch (error) { assert.fail(`${evidence}\ninvalid JSON: ${error.message}`); }
  return { document, evidence };
}

/** Check one refusal document, including the exact public code, message and next step. */
export async function jsonError(box, cwd, command, args, { status, code, message, next }, subcommand) {
  const result = await runLocal(box, cwd, command, ...args, '--json');
  assert.equal(result.status, status, `${command}: ${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', `${command} refusal must be JSON-only`);
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1);
  assertRequiredShape(document, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(document.error, JSON_SHAPES.errorFields, 'error');
  if (subcommand) shapeFor(command, subcommand);
  assert.deepEqual(document.error, { code, message, next });
  return document;
}

/** Assert only that output is a single JSON value with no second document. */
export function parseOneDocument(stdout) {
  const document = JSON.parse(stdout);
  assert.equal(document.version, 1);
  return document;
}
/**
 * The CLI entry for in-process API moves, run with only this box's environment.
 * Why: a move must not read the runner seat's own agent variables, which made a decision answer 409 [A2].
 */
export function isolatedMain(box) {
  return async (argv, io) => {
    const keys = new Set([...Object.keys(box.env), ...AGENT_SHELL_MARKERS, 'PULLBOARD_RELAY_TOKEN', 'npm_config_cache']);
    const previous = new Map([...keys].map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) {
        if (Object.hasOwn(box.env, key)) process.env[key] = box.env[key];
        else delete process.env[key];
      }
      process.env.npm_config_cache = join(box.dir, 'npm-cache');
      return await main(argv, io);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

/**
 * A project whose submits settle whatever the machine's dispatch default is, so the review a move queues is ready [P7].
 * Why: under pull dispatch a submit waits for a runner and the verifier's next answers REVIEW_NOT_READY (#6253).
 */
export function settledProject() {
  const box = project();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME);
  return box;
}

/**
 * Resolve once the board's runner job queue holds no unfinished job, read again on every change in the machine's local runner folder.
 * Why: under pull dispatch the loopback runner lands and gates after a move returns, so a journey that counts what a later
 * move recomputes waits for that work to finish first; the runner's folder changes with each claim, receipt and 5 s heartbeat [P7].
 */
export function jobQueueEmpty(box, { deadlineMs = 120_000 } = {}) {
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const runnerDir = join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner');
  return new Promise((resolveEmpty, rejectEmpty) => {
    let watcher = null;
    let open = -1;
    const stop = () => { watcher?.close(); clearTimeout(timer); };
    const probe = () => {
      const db = new DatabaseSync(boardFile, { readOnly: true });
      try { open = db.prepare("SELECT COUNT(*) AS open FROM job WHERE job_step <> 'done'").get().open; } catch { return; } finally { db.close(); }
      if (open === 0) { stop(); resolveEmpty(); }
    };
    const timer = setTimeout(() => { stop(); rejectEmpty(new Error(`the runner queue still holds ${open} unfinished job(s) after ${deadlineMs} ms`)); }, deadlineMs);
    try { watcher = watch(runnerDir, probe); } catch (error) { stop(); rejectEmpty(error); return; }
    probe();
  });
}

/** Serve the local API adapter directly so tests can exercise its optional origin allowlist. */
export async function startLocalHandler(t, box, options = {}) {
  const secret = randomUUID();
  let port = 0;
  const handler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument,
    secret,
    getPort: () => port,
    runCommand: options.runCommand ?? isolatedMain(box),
    projects: () => [{ root: box.repo, name: 'API fixture', project: '', added: '2026-01-01T00:00:00.000Z' }],
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.onStateBuild === undefined ? {} : { onStateBuild: options.onStateBuild }),
    ...(options.onItemBuild === undefined ? {} : { onItemBuild: options.onItemBuild }),
    ...(options.stateDetail === undefined ? {} : { stateDetail: options.stateDetail }),
    ...(options.personChannel === undefined ? {} : { personChannel: options.personChannel }),
  });
  const server = createServer(handler);
  await new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolveReady();
    });
  });
  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    handler.close();
    const closed = new Promise((resolveClosed) => server.close(resolveClosed));
    server.closeAllConnections();
    await closed;
  };
  t.after(close);
  return { origin: `http://127.0.0.1:${port}`, secret, close };
}

/** Start the real local API server and stop it when its test finishes. */
export async function startApi(t, box, { traceStartup = false, traceFile: requestedTraceFile, readinessTimeoutMs = 10_000,
  holdPhase, phaseReachedFile, releaseFile } = {}) {
  const traceFile = requestedTraceFile ?? (traceStartup
    ? process.env.PULLBOARD_STARTUP_TRACE_FILE ?? join(box.dir, 'serve-startup-trace.jsonl')
    : process.env.PULLBOARD_STARTUP_TRACE_FILE);
  const preloadFile = traceFile ? join(box.dir, 'startup-trace-preload.mjs') : null;
  const childEnv = traceFile ? { ...box.env, PULLBOARD_STARTUP_TRACE_FILE: traceFile,
    PULLBOARD_STARTUP_TRACE_ENTRY: BIN,
    ...(holdPhase ? { PULLBOARD_STARTUP_TEST_HOLD_PHASE: holdPhase,
      PULLBOARD_STARTUP_TEST_PHASE_REACHED_FILE: phaseReachedFile,
      PULLBOARD_STARTUP_TEST_RELEASE_FILE: releaseFile } : {}) } : box.env;
  const startedAt = performance.now();
  const args = traceFile
    ? ['--import', preloadFile, BIN, 'serve', '--port', '0', '--json']
    : [BIN, 'serve', '--port', '0', '--json'];
  if (traceFile) {
    const preloadLines = [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "import { loadavg } from 'node:os';",
      "import { performance } from 'node:perf_hooks';",
      'const originalAppendFileSync = fs.appendFileSync.bind(fs);',
      'fs.appendFileSync = (path, data, ...options) => {',
      '  const result = originalAppendFileSync(path, data, ...options);',
      "  if (String(path) === process.env.PULLBOARD_STARTUP_TRACE_FILE && process.env.PULLBOARD_STARTUP_TEST_HOLD_PHASE) {",
      "    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);",
      "    for (const line of text.split('\\n')) {",
      '      let event;',
      '      try { event = JSON.parse(line); } catch { continue; }',
      '      if (event.phase !== process.env.PULLBOARD_STARTUP_TEST_HOLD_PHASE) continue;',
      "      originalAppendFileSync(process.env.PULLBOARD_STARTUP_TEST_PHASE_REACHED_FILE, 'phase reached\\n');",
      '      const waitCell = new Int32Array(new SharedArrayBuffer(4));',
      '      while (!fs.existsSync(process.env.PULLBOARD_STARTUP_TEST_RELEASE_FILE)) Atomics.wait(waitCell, 0, 0, 25);',
      '      break;',
      '    }',
      '  }',
      '  return result;',
      '};',
      'syncBuiltinESMExports();',
      "originalAppendFileSync(process.env.PULLBOARD_STARTUP_TRACE_FILE, JSON.stringify({ phase: 'process-entry', at: Date.now(), elapsedMs: performance.now(), processId: process.pid, cpuUsage: process.cpuUsage(), loadAverage: loadavg(), eventLoopUtilization: performance.eventLoopUtilization() }) + '\\n');",
    ];
    writeFileSync(preloadFile, `${preloadLines.join('\n')}\n`);
    appendFileSync(traceFile, `${JSON.stringify({ phase: 'parent-spawn', at: Date.now(), elapsedMs: 0, processId: process.pid })}\n`);
  }
  const child = spawn(process.execPath, args, { cwd: box.repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      let timeout;
      await Promise.race([closed, new Promise((resolveDone) => { timeout = setTimeout(resolveDone, 10_000); })]);
      clearTimeout(timeout);
    }
  });
  const document = await new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const failStartup = (detail, status = child.exitCode, signal = child.signalCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(phaseWait);
      let startupDiagnostics = '';
      let startupPhases = [];
      if (traceFile) {
        try {
          startupPhases = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        } catch { /* An unavailable trace is reported as an empty capture. */ }
        const childStartedAt = startupPhases.find(({ phase }) => phase === 'process-entry')?.at ?? startupPhases[0]?.at;
        const phaseLines = startupPhases.map(({ phase, at }) => {
          const elapsed = Number.isFinite(at) && Number.isFinite(childStartedAt) ? Math.max(0, at - childStartedAt) : null;
          return `- ${phase}: ${elapsed === null ? 'time unavailable' : `${elapsed}ms since child start`}`;
        });
        const lastPhase = startupPhases.at(-1)?.phase ?? 'no startup phase was recorded';
        startupDiagnostics = `serve startup phases:\n${phaseLines.length ? phaseLines.join('\n') : '- no startup phases were recorded'}\nlast phase reached: ${lastPhase}`;
        t.diagnostic(startupDiagnostics);
      }
      if (releaseFile && holdPhase) writeFileSync(releaseFile, 'release after timeout trace snapshot\n');
      const failure = new Error(reportFixtureChildFailure({ command: process.execPath, args, status, signal,
        elapsedMs: performance.now() - startedAt, stderr, env: box.env,
        detail: startupDiagnostics ? `${detail}\n${startupDiagnostics}` : detail,
      }));
      failure.startupDiagnostics = startupDiagnostics;
      failure.startupPhases = startupPhases;
      rejectReady(failure);
    };
    let timeout;
    let phaseWait;
    const armReadinessDeadline = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => failStartup(`serve readiness deadline (${readinessTimeoutMs}ms) expired`), readinessTimeoutMs); // budget: caller-selected ceiling; default remains 10000ms from spawn.
    };
    if (holdPhase && phaseReachedFile) {
      timeout = setTimeout(() => failStartup(`test fixture did not reach startup phase ${holdPhase} within 10000ms`), 10_000); // budget: hang ceiling for deterministic phase arrival only.
      phaseWait = setInterval(() => {
        if (!existsSync(phaseReachedFile)) return;
        clearInterval(phaseWait);
        armReadinessDeadline();
      }, 5);
    } else {
      armReadinessDeadline();
    }
    const check = () => {
      try {
        const parsed = JSON.parse(stdout);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(phaseWait);
        resolveReady(parsed);
      } catch {
        // The startup envelope is pretty-printed across several chunks.
      }
    };
    child.stdout.on('data', check);
    child.once('error', (error) => failStartup(error.message, null, null));
    child.once('close', (code, signal) => failStartup('serve exited before readiness', code, signal));
    child.once('close', (code) => {
      if (code !== 0) { clearTimeout(timeout); rejectReady(new Error(`serve exited ${code}: ${stderr}`)); }
    });
  });
  if (traceFile) {
    appendFileSync(traceFile, `${JSON.stringify({ phase: 'parent-ready-observed', at: Date.now(), elapsedMs: performance.now() - startedAt, processId: process.pid })}\n`);
  }
  assert.equal(document.version, 1);
  const parsed = new URL(document.url);
  const secret = parsed.searchParams.get('k');
  assert.ok(secret, 'serve startup exposes its per-session secret in its private URL');
  return { child, document, origin: parsed.origin, secret, stderr: () => stderr };
}

/** An agent writing to the board from its own process until the stop file appears, then printing its write count. */
export const WRITER = `import { DatabaseSync } from 'node:sqlite'; import { existsSync } from 'node:fs';
const [file, stop] = process.argv.slice(1); const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000');
const insert = db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'edit', ?, '{}')");
let n = 0; process.stdout.write('ready\\n');
while (!existsSync(stop)) { db.exec('BEGIN IMMEDIATE'); insert.run(new Date().toISOString(), 1 + (n++ % 1000)); db.exec('COMMIT'); await new Promise((done) => setTimeout(done, 2)); }
db.close(); process.stdout.write(n + '\\n');`;
