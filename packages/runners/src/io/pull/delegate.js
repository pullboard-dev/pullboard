/** Dispatch a runner job by pulling: submit, wait on the shared mirror, finish; the controller path stays untouched [C7,#5465]. */
import { runnerDispatchMode } from '../../../../config/index.js';
import { controllerDeadline } from '../../../../resources/index.js';
import { recordRunnerDispatch } from '../../../../resources/index.js';
import { runOnRunnerAsync as controllerRunOnRunnerAsync } from '../dispatch.js';
import { bridgeResult } from '../dispatch.js';
import { MAX_OUTPUT_BYTES } from '../dispatch.js';
import { RunnerDropped } from '../main.js';
import { forgetRuntimeHeld } from '../runtime.js';
import { recordRuntimeHeld } from '../runtime.js';
import { committedRunnerController } from '../tooling/committed.js';
import { loadedToolingFiles } from '../tooling/remote.js';
import { probeRunnerJob } from '../health.js';
import { watchSource } from './observe.js';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Run one short controller mode and return its decoded answer, with the controller's own refusal and drop shapes. */
async function shortController(mode, payload, { root, runner, signal }) {
  const installation = committedRunnerController(fileURLToPath(new URL('../../../../../', import.meta.url)), { shared: true });
  try {
    if (!installation) loadedToolingFiles({ rescan: false });
    const entry = installation?.entry ?? fileURLToPath(new URL('../../../../../apps/runner/src/io/controller.js', import.meta.url));
    const child = spawn(process.execPath, [entry, '--pullboard-runner-controller', mode], { cwd: mode === '--submit' ? root : tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
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
  const custody = (ports.controllerDeadline ?? controllerDeadline)(options.metadata?.resourceOwner, process.pid, root);
  const span = { startedAt: dispatchStart, host: options.runner?.host ?? null, kind: options.metadata?.kind ?? null };
  const spawned = Date.now();
  const attempt = async () => {
    const watch = watchSource(root, options, custody, ports);
    const local = new AbortController();
    const abort = () => local.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let submitted, readyAt = null, serving = null, serveFailure = null, finished = false;
    try {
      submitted = await call('--submit', { root, command, options: plainOptions, parentPid: process.pid }, { root, runner: options.runner, signal });
      custody.job(submitted.recovery);
      const finish = extra => call('--finish', { id: submitted.id, readyAt, ...extra }, { root, runner: options.runner });
      const { waitRunnerJob } = ports.waitRunnerJob ? ports : await import('./wait.js');
      const end = await waitRunnerJob({
        runner: options.runner, id: submitted.id, signal: local.signal, startedAt: dispatchStart, parentPid: process.pid,
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
      const result = await finish({ reason, exit: end.job?.exit, unavailable: end.unavailable, cancellation: end.cancellation }).catch(failure => { throw serveFailure ?? end.error ?? failure; });
      if (serveFailure) throw serveFailure;
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
    recordRunnerDispatch({ ...span, endedAt: Date.now(), phases: result?.phases ? { ...result.phases, spawn: spawned } : null });
    return result;
  } catch (failure) {
    recordRunnerDispatch({ ...span, endedAt: Date.now(), error: failure });
    throw failure;
  } finally { custody.close(); }
}

/** Isolate asynchronous execution: the controller path by default, the pull path under the machine setting gate.runnerDispatch. */
export async function runOnRunnerAsync(root, command, options, ports = {}) {
  if ((ports.mode ?? runnerDispatchMode)() !== 'pull') return controllerRunOnRunnerAsync(root, command, options);
  return runPulled(root, command, options, ports);
}
