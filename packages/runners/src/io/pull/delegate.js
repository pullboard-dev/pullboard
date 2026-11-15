/** Dispatch a runner job by pulling: submit, wait on the shared mirror, finish; the controller path stays untouched [C7,#5465]. */
import { waitRunnerJob as defaultWait } from './wait.js';
import { runnerDispatchMode } from '../../../../config/index.js';
import { controllerDeadline } from '../../../../resources/index.js';
import { recordRunnerTime } from '../../../../resources/index.js';
import { recordRunnerDispatch } from '../../../../resources/index.js';
import { runOnRunnerAsync as controllerRunOnRunnerAsync } from '../dispatch.js';
import { bridgeResult } from '../dispatch.js';
import { MAX_OUTPUT_BYTES } from '../dispatch.js';
import { RunnerDropped } from '../main.js';
import { forgetRuntimeHeld } from '../runtime.js';
import { recordRuntimeHeld } from '../runtime.js';
import { committedRunnerController } from '../tooling/committed.js';
import { runnerControllerEntry } from '../tooling/committed.js';
import { loadedToolingFiles } from '../tooling/remote.js';
import { probeRunnerJob } from '../health.js';
import { watchSource } from './observe.js';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchRoot } from '../../../../config/index.js';

/**
 * The environment of a short controller: this user's private V8 compile cache, when it is a folder only this user can
 * write. Why: each pulled trip starts three controllers from one unchanged export, and each compiled the whole
 * controller graph again, 2-8 s apiece beside four other jobs (#8145); V8 keys each entry by its source's hash.
 */
function controllerEnvironment() {
  const folder = join(scratchRoot(), 'pullboard-controller-compile-cache');
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const state = statSync(folder);
    if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) return process.env;
  } catch { return process.env; }
  return { ...process.env, NODE_COMPILE_CACHE: folder };
}

/** Run one short controller mode and return its decoded answer, with the controller's own refusal and drop shapes. */
async function shortController(mode, payload, { root, runner, signal }) {
  const installation = committedRunnerController(fileURLToPath(new URL('../../../../../', import.meta.url)), { shared: true });
  try {
    if (!installation) loadedToolingFiles({ rescan: false });
    const entry = installation?.entry ?? runnerControllerEntry(fileURLToPath(new URL('../../../../../', import.meta.url)));
    const child = spawn(process.execPath, [entry, '--pullboard-runner-controller', mode], { cwd: mode === '--submit' ? root : scratchRoot(), env: controllerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    let bytes = 0, error;
    const stop = () => child.kill('SIGTERM');
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES * 6 + 1024 ** 2) { error ??= new Error('runner bridge output exceeded its JSON limit'); stop(); } else output.push(chunk); });
    child.stderr.on('data', chunk => { diagnostics.push(chunk); if (diagnostics.reduce((sum, value) => sum + value.length, 0) > 8192) diagnostics.splice(0, diagnostics.length, Buffer.concat(diagnostics).subarray(-8192)); });
    child.on('error', caught => { error ??= caught; });
    child.stdin.on('error', caught => { error ??= caught; });
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin.end(JSON.stringify(payload));
    try {
      const { status, signal: stopped } = await new Promise(resolve => child.once('close', (code, killed) => resolve({ status: code, signal: killed })));
      const stdout = Buffer.concat(output).toString('utf8');
      try { return bridgeResult({ options: { runner } }, { status, signal: stopped, error, stdout, stderr: Buffer.concat(diagnostics).toString('utf8') }, `pull-${mode.slice(2)}`); }
      catch (failure) {
        let reply; try { reply = JSON.parse(stdout); } catch { /* Not a controller envelope. */ }
        if (reply?.error?.workSpecVersions) failure.workSpecVersions = reply.error.workSpecVersions;
        throw failure;
      }
    } finally { signal?.removeEventListener('abort', stop); }
  } finally { installation?.cleanup(); }
}

/**
 * Submit, wait and finish one pulled job through the controller modes, returning the shapes the controller path does.
 * The caller holds the lease custody for the whole wait (it is the lease holder and its own controller), so no per-job
 * process lives between submit and finish.
 *
 * @param {string} root
 * @param {string} command
 * @param {object} options - As runOnRunnerAsync takes them.
 * @param {{ waitRunnerJob?: Function, call?: Function, controllerDeadline?: Function, runnerItemState?: Function, probeRunnerJob?: Function }} [ports] - Test seams.
 */
export async function runPulled(root, command, options, ports = {}) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  const dispatchStart = Date.now();
  const { signal, ...plainOptions } = options;
  const call = ports.call ?? shortController;
  // One shared tooling export serves the trip's submit, serve-need and finish controllers, and this process keeps its
  // latest one for its next trip: each short controller releases its export, and the last release deleted it, so every
  // trip exported the tooling tree three times, about 2 s each on a loaded runner (#8129). keepExport bounds the hold.
  const held = ports.call ? null : committedRunnerController(fileURLToPath(new URL('../../../../../', import.meta.url)), { shared: true });
  let custody;
  try { custody = (ports.controllerDeadline ?? controllerDeadline)(options.metadata?.resourceOwner, process.pid, root); }
  catch (failure) { held?.cleanup(); throw failure; }
  const span = { startedAt: dispatchStart, host: options.runner?.host ?? null, kind: options.metadata?.kind ?? null };
  const spawned = Date.now();
  const attempt = async () => {
    const watch = watchSource(root, options, custody, ports);
    const local = new AbortController();
    const abort = () => local.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let submitted, readyAt = null, needAt = null, serving = null, serveFailure = null, finished = false;
    try {
      submitted = await call('--submit', { root, command, options: plainOptions, parentPid: process.pid }, { root, runner: options.runner, signal });
      // The job exists on the runner only now: a status mirror that began earlier may not list it, and is never read as a lost job.
      const queuedAt = Date.now();
      custody.job(submitted.recovery);
      const finish = extra => call('--finish', { id: submitted.id, readyAt, ...extra }, { root, runner: options.runner });
      const waitRunnerJob = ports.waitRunnerJob ?? defaultWait;
      const end = await waitRunnerJob({
        runner: options.runner, id: submitted.id, signal: local.signal, startedAt: queuedAt, parentPid: process.pid,
        startupDeadline: submitted.startupDeadline, ceilingMs: submitted.ceilingMs,
        /** One observation per fresh mirror: the lease before READY, the source and item always. */
        observe() {
          const cancellation = watch();
          if (cancellation) return { end: 'source-changed', finishReason: 'source-changed', cancellation };
          if (readyAt === null) {
            try { const unavailable = custody.unavailable(); if (unavailable?.host === submitted.host) return { end: 'unavailable', finishReason: 'unavailable', unavailable }; } catch { /* An unknown lease observation cannot stop the job. */ }
          }
          return null;
        },
        onNeed: (id, inventory) => {
          needAt ??= Date.now();
          serving ??= call('--serve-need', { id, inventory }, { root, runner: options.runner }).catch(failure => { serveFailure = failure; throw failure; });
          return serving;
        },
        onReady() {
          readyAt = Date.now();
          recordRuntimeHeld(submitted.host, submitted.toolingSha);
          try { custody.ready(submitted.readyTimeoutMs ?? undefined); } catch (failure) { serveFailure = failure; local.abort(); }
        },
      });
      await serving?.catch(() => {});
      if (readyAt === null && submitted.reusedRuntime) forgetRuntimeHeld(submitted.host, submitted.toolingSha);
      // A waiter's own fault or a failed pack upload ends the job as canceled; the fault is what the caller sees.
      const reason = signal?.aborted || serveFailure || end.end === 'error' ? 'canceled' : end.end === 'result' ? 'result' : end.finishReason;
      finished = true;
      const doneAt = Date.now();
      const result = await finish({ reason, exit: end.job?.exit, unavailable: end.unavailable, cancellation: end.cancellation }).catch(failure => { throw serveFailure ?? end.error ?? failure; });
      if (serveFailure) throw serveFailure;
      // The waiter's own marks complete the job's, so roundTripProfile can name every phase of the trip (#8129).
      if (result?.phases) result.phases = { ...result.phases, dispatch: dispatchStart, submitted: queuedAt, ...(needAt ? { need: needAt } : {}), done: doneAt, end: Date.now() };
      return result;
    } catch (failure) {
      if (submitted && !finished) { finished = true; await call('--finish', { id: submitted.id, reason: 'canceled', readyAt }, { root, runner: options.runner }).catch(() => {}); }
      throw serveFailure ?? failure;
    } finally { signal?.removeEventListener('abort', abort); }
  };
  try {
    let result;
    try { result = await attempt(); }
    catch (failure) {
      if (failure.code !== 'RUNNER_WORK_SPEC' || !failure.workSpecVersions) throw failure;
      // One refresh only, on an explicit pre-execution version mismatch, as the controller path does [C7,#2855].
      result = await attempt();
    }
    recordRunnerTime(root, { ...span, item: options.metadata?.item, endedAt: Date.now() });
    recordRunnerDispatch({ ...span, endedAt: Date.now(), phases: result?.phases ? { ...result.phases, spawn: spawned } : null });
    return result;
  } catch (failure) {
    recordRunnerTime(root, { ...span, item: options.metadata?.item, endedAt: Date.now(), error: failure });
    recordRunnerDispatch({ ...span, endedAt: Date.now(), error: failure });
    throw failure;
  } finally { custody.close(); if (held) keepExport(held); }
}

/** The tooling export this process keeps between its pulled trips; at most one, so each process holds at most one idle export. */
let keptExport = null;

/**
 * Keep this trip's export for the process's next trip, releasing the one kept before unless it is the same folder.
 * Why: a gate sends its shards and proofs one after another from one process, and each paid a whole export (#8129).
 * A kept export holds a lease like any run, so another process never removes it; once this process exits, its lease
 * is dead and the next sweep (SHARED_KEEP_COUNT) or release removes the folder.
 */
function keepExport(held) {
  const previous = keptExport;
  keptExport = held;
  previous?.cleanup();
}

/** Isolate asynchronous execution: the controller path by default, the pull path under the machine setting gate.runnerDispatch. */
export async function runOnRunnerAsync(root, command, options, ports = {}) {
  if ((ports.mode ?? runnerDispatchMode)() !== 'pull') return controllerRunOnRunnerAsync(root, command, options);
  return runPulled(root, command, options, ports);
}
