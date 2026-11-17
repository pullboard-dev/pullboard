/** The live asynchronous runner front and its bridge deadline, apart from the SSH controller in dispatch.js [C7,#9890]. */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RunnerDropped } from './result.js';
import { recordRunnerDispatch } from '../../../resources/index.js';
import { recordRunnerTime } from '../../../resources/index.js';
import { ownedTransportCompletion } from '../../../transport/index.js';
import { MAX_OUTPUT_BYTES } from './bridge.js';
import { bridgeResult } from './bridge.js';
import { startupDeadline } from './bridge.js';
import { PARENT_PIPE_FD } from './controller/watch.js';
import { committedRunnerController } from './tooling/committed.js';
import { runnerControllerEntry } from './tooling/committed.js';
import { loadedToolingFiles } from './tooling/remote.js';
export { MAX_OUTPUT_BYTES, RUN_CEILING_MS, bridgeResult, runCeilingMs, runnerUnavailableRefusal, startupDeadline } from './bridge.js';
export { ownedTransportCompletion };

// Budget: after a check's own ceiling and its startup window, the synchronous bridge gets this much more to report before it is killed.
const BRIDGE_GRACE_MS = 120_000;


/**
 * The longest a synchronous bridge may block its caller: the run's startup window plus its own timeout plus a grace,
 * or null when the request names no timeout (a landing or main comparison keeps its own bound).
 * Why: the verify path's private check on a runner blocks in spawnSync, which froze the slot heartbeat and held
 * runner .52 for 29 minutes with no test process (#6435, #8557); a hang now ends as RUNNER_BRIDGE_DEADLINE [C7].
 *
 * @param {{ runnerWaitDeadline?: number, runnerStartupMs?: number, timeoutMs?: number, privateCheck?: { timeoutMs?: number } }} options
 * @param {number} [now]
 * @returns {number | null}
 */
export function bridgeDeadlineMs(options, now = Date.now()) {
  const timeout = options.privateCheck?.timeoutMs ?? options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return null;
  const startup = startupDeadline(options, now);
  return Math.max(0, (startup ?? now) - now) + timeout + BRIDGE_GRACE_MS;
}

/** Isolate asynchronous execution from dependencies cached before an installation upgrade. */
export async function runOnRunnerAsync(root, command, options) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  // The dispatch span starts before the tooling export, so the export is attributed, not a gap after admission [C7].
  const dispatchStart = Date.now();
  // Preserve the stale-controller refusal; full provenance and transfer scans run once in the fresh process.
  const installation = committedRunnerController(fileURLToPath(new URL('../../../../', import.meta.url)), { shared: true });
  try {
  if (!installation) loadedToolingFiles({ rescan: false });
  const { signal, ...plainOptions } = options;
  const request = { root, command, options: plainOptions, parentPid: process.pid, parentPipe: PARENT_PIPE_FD };
  const input = JSON.stringify(request);
  const child = spawn(process.execPath, [installation?.entry ?? runnerControllerEntry(fileURLToPath(new URL('../../../../', import.meta.url))), '--pullboard-runner-controller'], {
    cwd: root, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const output = [], diagnostics = [];
  let bytes = 0, error;
  // Budget: retain the synchronous bridge's worst-case JSON escaping limit, never an unbounded child response.
  const limit = MAX_OUTPUT_BYTES * 6 + 1024 ** 2;
  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > limit) { error ??= new Error('runner bridge output exceeded its JSON limit'); abort(); }
    else output.push(chunk);
  });
  child.stderr.on('data', chunk => {
    diagnostics.push(chunk);
    if (diagnostics.reduce((sum, value) => sum + value.length, 0) > 8192) {
      const tail = Buffer.concat(diagnostics).subarray(-8192); diagnostics.splice(0, diagnostics.length, tail);
    }
  });
  child.on('error', caught => { error ??= caught; });
  child.stdin.on('error', caught => { error ??= caught; });
  child.stdin.end(input);
  // Each dispatch records its transfer, READY and run spans for an open gate's telemetry [C7].
  const span = { startedAt: dispatchStart, host: options.runner?.host ?? null, kind: options.metadata?.kind ?? null };
  const spawned = Date.now();
  try {
    const { status, signal: stopped } = await new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
    const result = bridgeResult(request, { status, signal: stopped, error, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(diagnostics).toString('utf8') }, 'async-bridge');
    recordRunnerTime(root, { ...span, item: options.metadata?.item, endedAt: Date.now() });
    recordRunnerDispatch({ ...span, endedAt: Date.now(), phases: result?.phases ? { ...result.phases, spawn: spawned } : null });
    return result;
  } catch (failure) {
    recordRunnerTime(root, { ...span, item: options.metadata?.item, endedAt: Date.now(), error: failure });
    recordRunnerDispatch({ ...span, endedAt: Date.now(), error: failure });
    throw failure;
  } finally { signal?.removeEventListener('abort', abort); }
  } finally { installation?.cleanup(); }
}

/** Give a pre-upgrade cached self-spawn caller a typed restart without reading input or starting transport. */
export function refuseLegacyControllerEntry(entry) {
  if (process.argv[2] !== '--pullboard-runner-controller' || !process.argv[1]) return;
  try { if (realpathSync(process.argv[1]) !== fileURLToPath(entry)) return; }
  catch { return; }
  process.stdout.write(JSON.stringify({ error: { name: 'Refused', code: 'RUNNER_TOOLING_CHANGED',
    message: 'runner controller entry changed; restart the command from the current committed CLI before retrying' } }));
  process.exitCode = 1;
}
