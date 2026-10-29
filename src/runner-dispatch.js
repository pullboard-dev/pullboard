/** Dispatch runner work through a fresh controller process and hold its SSH session [C7]. */
import { RunnerDropped } from './gate-policy-load.js';
import { Refused } from './refused.js';
import { historyPack } from './runner-history-pack.js';
import { loadedToolingFiles } from './runner-remote-tooling.js';
import { requestFor } from './runner-request.js';
import { resultFrom } from './runner-result.js';
import { runnerFailure } from './runner-result.js';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { openSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Budget: 64 MiB bounds worst-case JSON bridge escaping below Node string limits.
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;

/** Reconstruct the native transport outcome across a fresh controller process. */
function bridgeResult(request, result, phase) {
  let reply;
  try { reply = JSON.parse(result.stdout); }
  catch { throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-json'); }
  if (reply.error?.name === 'Refused') {
    const prefix = `[${reply.error.code}] `;
    const refused = new Refused(reply.error.code, reply.error.message.startsWith(prefix) ? reply.error.message.slice(prefix.length) : reply.error.message);
    if (reply.error.runnerAttempt) refused.runnerAttempt = reply.error.runnerAttempt;
    throw refused;
  }
  if (reply.error?.name === 'RunnerDropped') throw new RunnerDropped(request.options.runner.host, reply.error.diagnostic);
  if (reply.error || result.error || result.status !== 0) throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-exit');
  return reply.result;
}

/** Keep synchronous callers on the same fresh controller entry without a second bridge. */
export function runOnRunner(root, command, options) {
  const request = { root, command, options, parentPid: process.pid };
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/runner-controller.js', import.meta.url)), '--pullboard-runner-controller'], {
    cwd: root, input: JSON.stringify(request), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES * 6 + 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return bridgeResult(request, child, 'sync-bridge');
}

/** Isolate asynchronous execution from dependencies cached before an installation upgrade. */
export async function runOnRunnerAsync(root, command, options) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  // Preserve the stale-controller refusal; full provenance and transfer scans run once in the fresh process.
  loadedToolingFiles({ rescan: false });
  const { signal, ...plainOptions } = options;
  const request = { root, command, options: plainOptions, parentPid: process.pid };
  const input = JSON.stringify(request);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/runner-controller.js', import.meta.url)), '--pullboard-runner-controller'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
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
  try {
    const { status, signal: stopped } = await new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
    return bridgeResult(request, { status, signal: stopped, error, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(diagnostics).toString('utf8') }, 'async-bridge');
  } finally { signal?.removeEventListener('abort', abort); }
}

/** Serve only a directly launched controller, whose dependency cache starts in this process. */
export async function serveRunnerController(ports) {
  if (typeof ports?.privateCheckEnvelope !== 'function' || typeof ports?.privateCheckPhases !== 'function') throw new TypeError('runner controller needs native private-check policy ports');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  const canceled = new AbortController();
  const abort = () => canceled.abort();
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, abort);
  process.stdout.on('error', abort);
  // Budget: notice loss of the exact originating controller once per second while SSH is active.
  const parentWatch = setInterval(() => { if (process.ppid !== request.parentPid) abort(); }, 1000);
  if (process.ppid !== request.parentPid) abort();
  try { process.stdout.write(JSON.stringify({ result: await runInController(request.root, request.command, { ...request.options, signal: canceled.signal }, ports) })); }
  catch (error) {
    process.stdout.write(JSON.stringify({ error: { name: error.name, code: error.code, message: error.message, host: error.host, runnerAttempt: error.runnerAttempt, diagnostic: error.diagnostic } }));
    process.exitCode = 1;
  } finally { clearInterval(parentWatch); }
}

/** Negotiate missing history objects while the remote cache lease stays held in one SSH session. */
async function runInController(root, command, options, ports) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  const request = await requestFor(root, command, options, ports);
  let removeAbort = () => {};
  let runnerWaitTimer;
  let runnerWaitKill;
  let rawFd = null;
  try {
    if (request.rawOutputPath) rawFd = openSync(request.rawOutputPath, 'wx', 0o600);
    request.phase = 'connect';
    const child = spawn('ssh', request.args, { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    let bytes = 0, error, control = '', requested = false, transfer = null, cleanupReason = '';
    const rawHash = createHash('sha256');
    let rawBytes = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0);
    const half = 4 * 1024 ** 2;
    const abort = () => { error ??= new Error('runner transport canceled'); child.stdin.destroy(); child.kill('SIGTERM'); };
    // Bound connection, worker admission and checkout, until READY immediately before execution.
    // An executing test keeps its existing test timeout and may outlive the runner wait.
    if (Number.isSafeInteger(options.runnerWaitDeadline)) runnerWaitTimer = setTimeout(() => {
      request.admissionDeadlineExceeded = true;
      abort();
      // Budget: a non-responsive SSH child cannot retain a local reservation forever.
      runnerWaitKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, Math.max(0, options.runnerWaitDeadline - Date.now()));
    options.signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) abort();
    /** Bound both protocol streams before retaining a complete result. */
    const capture = (target, chunk, raw = false) => {
      if (raw && rawFd !== null) {
        if (error) return;
        try {
          for (let offset = 0; offset < chunk.length;) {
            const written = writeSync(rawFd, chunk, offset, chunk.length - offset);
            if (written <= 0) throw new Error('private-check output made no capture progress');
            offset += written;
          }
          rawHash.update(chunk); rawBytes += chunk.length;
          const take = Math.min(chunk.length, half - head.length);
          if (take) head = Buffer.concat([head, chunk.subarray(0, take)]);
          if (chunk.length > take) tail = Buffer.concat([tail, chunk.subarray(take)]).subarray(-half);
        } catch { error = new Refused('RUNNER_OUTPUT_LIMIT', 'the full private-check output could not be captured; restore its artifact storage before retrying'); child.kill('SIGTERM'); }
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { error = new Refused('RUNNER_OUTPUT_LIMIT', 'runner output exceeded 64 MiB; reduce command output or keep this run local'); child.kill(); }
      else target.push(chunk);
    };
    child.stdout.on('data', chunk => capture(output, chunk, true));
    child.stderr.on('data', chunk => {
      capture(diagnostics, chunk);
      control += chunk.toString('utf8');
      // Budget: eight MiB of component receipts plus base64/JSON framing, inside the total 64-MiB bound.
      if (control.length > 16 * 1024 ** 2) { error = new Error('runner control frame exceeded limit'); child.kill(); return; }
      let newline;
      while ((newline = control.indexOf('\n')) >= 0) {
        const line = control.slice(0, newline); control = control.slice(newline + 1);
        if (line === `PULLBOARD_RUNNER_READY ${request.spec.id}`) { request.phase = 'ready'; clearTimeout(runnerWaitTimer); }
        const cleanupPrefix = `PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${request.spec.id} `;
        if (line.startsWith(cleanupPrefix)) cleanupReason = line.slice(cleanupPrefix.length, cleanupPrefix.length + 240);
        if (line === `PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${request.spec.id}`) {
          error = new Refused('RUNNER_CLEANUP_TIMEOUT', `runner ${request.runner.host} could not verify cleanup within 30 seconds${cleanupReason ? ': ' + cleanupReason : ''}; inspect job ${request.spec.id} under its runner namespace before another run`);
          error.diagnostic = runnerFailure(request, { status: null, stderr: '' }, 'cleanup-unverified').diagnostic;
          child.stdin.destroy(); child.kill('SIGTERM'); return;
        }
        const prefix = `PULLBOARD_RUNNER_NEED ${request.spec.id} `;
        if (!line.startsWith(prefix)) continue;
        if (requested) { error = new Error('duplicate runner inventory'); child.kill(); return; }
        requested = true; request.phase = 'inventory';
        transfer = (async () => {
          const inventory = JSON.parse(Buffer.from(line.slice(prefix.length), 'base64').toString('utf8'));
          if (!Array.isArray(inventory.tips) || inventory.tips.length > 1024
            || inventory.tips.some(tip => typeof tip !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tip))) {
            throw new Error('invalid runner inventory');
          }
          if (!Array.isArray(inventory.tagObjects) || inventory.tagObjects.length > 8_192
            || inventory.tagObjects.some(object => typeof object !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object))) {
            throw new Error('invalid runner tag inventory');
          }
          request.phase = 'pack';
          const pack = historyPack(root, request.source, inventory.tips, request.directory, request.spec.tags, inventory.tagObjects);
          await pipeline(createReadStream(pack), child.stdin);
          if (request.phase !== 'ready') request.phase = 'source-sent';
        })().catch(failure => { error = failure; child.stdin.destroy(); child.kill(); });
      }
    });
    child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
    child.once('error', failure => { error = failure; });
    child.stdin.write(request.frame);
    const {status,signal} = await new Promise(resolve => child.once('close', (status,signal) => resolve({status,signal})));
    if (transfer) await transfer;
    if (error instanceof Refused) throw error;
    if (rawFd !== null) { closeSync(rawFd); rawFd = null; }
    const bounded = request.rawOutputPath ? Buffer.concat([head, ...(rawBytes > half * 2 ? [Buffer.from('\n[output capped at 8 MiB; middle omitted]\n')] : []), tail]) : Buffer.concat(output);
    return resultFrom(request, { status, signal, error, stdout: bounded, stderr: Buffer.concat(diagnostics),
      ...(request.rawOutputPath ? { rawOutputPath: request.rawOutputPath, rawBytes, rawSha256: rawHash.digest('hex') } : {}) }, ports);
  } finally { clearTimeout(runnerWaitTimer); clearTimeout(runnerWaitKill); if (rawFd !== null) closeSync(rawFd); removeAbort(); request.cleanup(); }
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
