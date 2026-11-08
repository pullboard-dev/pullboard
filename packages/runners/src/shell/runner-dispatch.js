import { committedRunnerController } from './committed-tooling.js';

/** How often a waiting controller re-reads its runner's lease before the job is READY. */
const LEASE_WATCH_MS = 5_000;
/** Dispatch runner work through a fresh controller process and hold its SSH session [C7]. */
import { RunnerDropped } from '../../../gate/src/core/gate-policy-load.js';
import { Refused } from '../../../kernel/index.js';
import { historyPack } from './runner-history-pack.js';
import { loadedToolingFiles } from './runner-remote-tooling.js';
import { requestFor } from './runner-request.js';
import { resultFrom } from './runner-result.js';
import { runnerFailure } from './runner-result.js';
import { readCleanupTimeoutDetails } from '../core/cleanup-diagnostics.js';
import { cleanupProcessText } from '../core/cleanup-diagnostics.js';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { openSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { controllerWake } from './controller-watch.js';
import { PARENT_PIPE_FD } from './controller-watch.js';

// Budget: 64 MiB bounds worst-case JSON bridge escaping below Node string limits.
// Budget: after the receipt, wait this long for the last output bytes before ending the transport; the worker finishes cleanup on its own.
const RECEIPT_GRACE_MS = 500;
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;

/** Bound stopping only this owned child and its pipes; local settlement never proves remote cleanup. */
export function ownedTransportCompletion(child, { termMs = 1_000, drainMs = 1_000 } = {}) {
  let term, drain, stopping = false, observed = null, force;
  const forced = new Promise(resolve => { force = resolve; });
  const exited = (status, signal) => { observed = { status, signal }; };
  let closed;
  const complete = new Promise(resolve => { closed = (status, signal) => resolve({ status, signal, forced: false }); });
  child.once('exit', exited); child.once('close', closed);
  return {
    wait: () => Promise.race([complete, forced]),
    stop() {
      if (stopping) return;
      stopping = true;
      child.stdin?.destroy(); child.kill('SIGTERM');
      term = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        drain = setTimeout(() => {
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          force({ ...(observed ?? { status: null, signal: null }), forced: true });
        }, drainMs);
      }, termMs);
    },
    dispose() { clearTimeout(term); clearTimeout(drain); child.removeListener('exit', exited); child.removeListener('close', closed); },
  };
}

/** Reconstruct the native transport outcome across a fresh controller process. */
function bridgeResult(request, result, phase) {
  let reply;
  try { reply = JSON.parse(result.stdout); }
  catch { throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-json'); }
  if (reply.error?.name === 'Refused') {
    const prefix = `[${reply.error.code}] `;
    const refused = new Refused(reply.error.code, reply.error.message.startsWith(prefix) ? reply.error.message.slice(prefix.length) : reply.error.message);
    if (reply.error.runnerAttempt) refused.runnerAttempt = reply.error.runnerAttempt;
    if (reply.error.runnerCancellation) refused.runnerCancellation = reply.error.runnerCancellation;
    if (reply.error.diagnostic) refused.diagnostic = reply.error.diagnostic;
    throw refused;
  }
  if (reply.error?.name === 'RunnerDropped') throw new RunnerDropped(request.options.runner.host, reply.error.diagnostic);
  if (reply.error || result.error || result.status !== 0) throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-exit');
  return reply.result;
}

/** Keep synchronous callers on the same fresh controller entry without a second bridge. */
export function runOnRunner(root, command, options) {
  const request = { root, command, options, parentPid: process.pid, parentPipe: PARENT_PIPE_FD };
  const installation = committedRunnerController(fileURLToPath(new URL('../../../../', import.meta.url)));
  try {
  const child = spawnSync(process.execPath, [installation?.entry ?? fileURLToPath(new URL('../../../../bin/runner-controller.js', import.meta.url)), '--pullboard-runner-controller'], {
    cwd: root, input: JSON.stringify(request), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES * 6 + 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  return bridgeResult(request, child, 'sync-bridge');
  } finally { installation?.cleanup(); }
}

/** Isolate asynchronous execution from dependencies cached before an installation upgrade. */
export async function runOnRunnerAsync(root, command, options) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  // Preserve the stale-controller refusal; full provenance and transfer scans run once in the fresh process.
  const installation = committedRunnerController(fileURLToPath(new URL('../../../../', import.meta.url)));
  try {
  if (!installation) loadedToolingFiles({ rescan: false });
  const { signal, ...plainOptions } = options;
  const request = { root, command, options: plainOptions, parentPid: process.pid, parentPipe: PARENT_PIPE_FD };
  const input = JSON.stringify(request);
  const child = spawn(process.execPath, [installation?.entry ?? fileURLToPath(new URL('../../../../bin/runner-controller.js', import.meta.url)), '--pullboard-runner-controller'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
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
  } finally { installation?.cleanup(); }
}

/** Serve only a directly launched controller, whose dependency cache starts in this process. */
export async function serveRunnerController(ports) {
  if (typeof ports?.privateCheckEnvelope !== 'function' || typeof ports?.privateCheckPhases !== 'function') throw new TypeError('runner controller needs native private-check policy ports');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (typeof ports.runnerItemState !== 'function' || typeof ports.controllerDeadline !== 'function'
    || typeof ports.probeRunnerJob !== 'function') throw new Refused('RUNNER_LIFECYCLE_PROVIDER', 'runner controller needs its canonical item lifecycle, deadline and exact-job observers');
  const canceled = new AbortController();
  const custody = ports.controllerDeadline(request.options.metadata?.resourceOwner, request.parentPid, request.root);
  let cancellation = null;
  const abort = () => canceled.abort();
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, abort);
  process.stdout.on('error', abort);
  const roots = [...new Set([request.root, fileURLToPath(new URL('../../../../', import.meta.url))])];
  const identities = roots.map(root => {
    try { const state = statSync(root); return { root, dev: state.dev, ino: state.ino }; }
    catch (error) { return { root, error: error.code }; }
  });
  let item;
  try {
    item = ports.runnerItemState(request.root, request.options.metadata?.item);
    const label = String(request.options.metadata?.item ?? ''), id = Number(label);
    if (!item && /^[1-9][0-9]*$/u.test(label) && Number.isSafeInteger(id)) {
      item = { item: id, board: null };
      custody.observationProblem('item status is unavailable');
    }
  }
  catch (error) {
    item = { item: Number(request.options.metadata?.item), board: null };
    custody.observationProblem(`initial item observation failed: ${error.code ?? error.name}`);
  }
  /** Observe only this request's source identities; cancellation drains its owned transport below. */
  const observe = () => {
    if (cancellation) abort();
    if (process.ppid !== request.parentPid) abort();
    for (const expected of identities) {
      let reason;
      try {
        const state = statSync(expected.root);
        if (expected.error || !state.isDirectory() || state.dev !== expected.dev || state.ino !== expected.ino) reason = 'source identity changed';
      } catch (error) { reason = `source observation failed: ${error.code}`; }
      if (reason) {
        cancellation ??= { version: 1, reason, root: expected.root };
        abort();
      }
    }
    if (item && !cancellation) {
      let problem;
      try {
        const current = ports.runnerItemState(request.root, item.item);
        if (!current) problem = 'item status is unavailable';
        else if (current.item !== item.item || item.board && current.board !== item.board) problem = 'item board identity changed';
        else {
          if (!item.board) item = current;
          if (current.terminal) {
            cancellation = { version: 1, reason: 'item is terminal', root: request.root, board: item.board, item: item.item };
            abort();
          }
        }
      } catch (error) { problem = `item observation failed: ${error.code ?? error.name}`; }
      custody.observationProblem(problem);
    }
  };
  let itemFiles = [];
  try { itemFiles = item && typeof ports.runnerItemSources === 'function' ? ports.runnerItemSources(request.root) : []; } catch { /* The wake falls back to its timer. */ }
  const stopWatching = controllerWake(request, { roots, itemFiles, needsBoard: Boolean(item), abort, observe });
  observe();
  try {
    let result;
    try { result = await runInController(request.root, request.command, { ...request.options, signal: canceled.signal }, { ...ports, controllerCustody: custody }); }
    catch (error) {
      if (error.code !== 'RUNNER_WORK_SPEC' || !error.workSpecVersions) throw error;
      // A new request rebuilds and sends the pinned capsule, whose installer checks every runtime byte.
      // Only an explicit pre-execution version mismatch gets this one refresh; malformed specs never retry [C7,#2855].
      result = await runInController(request.root, request.command, { ...request.options, signal: canceled.signal }, { ...ports, controllerCustody: custody });
    }
    if (cancellation) throw new Error('source cancellation completed without a transport failure');
    process.stdout.write(JSON.stringify({ result }));
  }
  catch (error) {
    if (cancellation) {
      const original = error;
      error = new Refused('RUNNER_SOURCE_CHANGED', `controller stopped: ${cancellation.reason} (${cancellation.root})`);
      error.runnerCancellation = { ...cancellation, diagnostic: original.diagnostic ?? { reason: 'source-cancelled', phase: 'controller' } };
    }
    process.stdout.write(JSON.stringify({ error: { name: error.name, code: error.code, message: error.message, host: error.host, runnerAttempt: error.runnerAttempt, diagnostic: error.diagnostic, runnerCancellation: error.runnerCancellation } }));
    process.exitCode = 1;
  } finally { stopWatching(); custody.close(); }
}

/**
 * The refusal of a job whose runner went unavailable while it waited for READY. Its diagnostic's reason is
 * runner-unavailable: the gate requeues it as cleanup-unverified, and recordRunnerFailure keeps the runner's existing
 * quarantine instead of writing a second one, so one drop is one quarantine (#3698) [C7].
 *
 * @param {{ runner: { host: string }, spec: { id: string } }} request
 * @param {{ host: string, reason: string }} unavailable - The runner's lease observation.
 * @returns {Refused}
 */
export function runnerUnavailableRefusal(request, unavailable) {
  const error = new Refused('RUNNER_UNAVAILABLE', `runner ${unavailable.host} became ${unavailable.reason} while job ${request.spec.id} waited for READY; release its lease and dispatch once to a healthy runner`);
  error.diagnostic = { ...runnerFailure(request, { status: null, stderr: '' }, 'runner-unavailable').diagnostic,
    unavailable, remoteCleanup: 'unknown' };
  return error;
}

/** Negotiate missing history objects while the remote cache lease stays held in one SSH session. */
async function runInController(root, command, options, ports) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  const request = await requestFor(root, command, options, ports);
  const deadline = ports.controllerCustody;
  deadline?.job?.(request.spec.recovery);
  let removeAbort = () => {};
  let runnerWaitTimer;
  let jobWatch, heartbeatWatch, transport, receiptSeen = false, receiptTimer;
  const jobCancellation = new AbortController();
  let rawFd = null;
  try {
    if (request.rawOutputPath) rawFd = openSync(request.rawOutputPath, 'wx', 0o600);
    /** Record when each dispatch phase began, so a slow shard names its slow step [C7]. */
    const mark = phase => { request.phase = phase; (request.phaseAt ??= { start: Date.now() })[phase] = Date.now(); };
    mark('connect');
    const child = spawn('ssh', request.args, { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
    transport = ownedTransportCompletion(child);
    const output = [], diagnostics = [];
    let bytes = 0, error, control = '', requested = false, transfer = null, cleanupReason = '', cleanupDetails = null;
    const rawHash = createHash('sha256');
    let rawBytes = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0);
    const half = 4 * 1024 ** 2;
    const abort = () => { error ??= new Error('runner transport canceled'); transport.stop(); };
    let heartbeatAt = null, probing = false;
    // Until READY, watch this runner's lease every five seconds; the job itself then runs on heartbeat deadlines alone.
    // Why: at one second, 21 waiting controllers cost the coordinator Mac 2.6 cores and a lock on resources.sqlite
    // each tick (SLOT_DB_LOCKED, load 100+ on 6 Nov); a five-second notice of an unavailable runner is still prompt.
    jobWatch = setInterval(async () => {
      if (request.phase !== 'ready' && !error && !options.signal?.aborted) {
        try {
          const unavailable = deadline.unavailable();
          if (unavailable?.host === request.runner.host) {
            error = runnerUnavailableRefusal(request, unavailable);
            transport.stop();
          }
        } catch { /* Unknown or foreign lease observation cannot stop this owned transport. */ }
      }
    }, LEASE_WATCH_MS);
    // Budget: an exact 5-second worker heartbeat earns 20 seconds of silence before one bounded status observation.
    const silence = () => { clearTimeout(heartbeatWatch); if (!error && !jobCancellation.signal.aborted) heartbeatWatch = setTimeout(probeJob, Math.max(0, heartbeatAt + 20_000 - Date.now())); };
    /** Ask the runner whether the exact job still has its owner, once the worker has been silent for 20 seconds. */
    const probeJob = async () => {
      if (request.phase !== 'ready' || heartbeatAt === null || probing || error) return;
      if (Date.now() - heartbeatAt < 20_000) return silence();
      probing = true;
      try {
        const state = await ports.probeRunnerJob(request.runner, { job: request.spec.id, recovery: request.spec.recovery }, { signal: jobCancellation.signal });
        heartbeatAt = Date.now();
        if (state?.state !== 'gone' || state.job !== request.spec.id
          || !['version', 'request', 'nonce', 'tooling', 'launchFence'].every(key => state.recovery?.[key] === request.spec.recovery?.[key])
          || error || options.signal?.aborted || jobCancellation.signal.aborted) return;
        error = new Refused('RUNNER_JOB_LOST', `runner ${request.runner.host} lost exact job ${request.spec.id}: its recorded startup owner is gone; remote cleanup remains unknown`);
        error.diagnostic = { ...runnerFailure(request, { status: null, stderr: '' }, 'job-owner-gone').diagnostic,
          host: request.runner.host, job: request.spec.id, owner: state.owner, remoteCleanup: 'unknown' };
        transport.stop();
      } catch { heartbeatAt = Date.now(); /* An unavailable exact-job observer supplies no absence authority. */ }
      finally { probing = false; silence(); }
    };
    // Bound connection, worker admission and checkout, until READY immediately before execution.
    // An executing test keeps its existing test timeout and may outlive the runner wait.
    if (Number.isSafeInteger(options.runnerWaitDeadline)) runnerWaitTimer = setTimeout(() => {
      request.admissionDeadlineExceeded = true;
      abort();
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
        } catch { error = new Refused('RUNNER_OUTPUT_LIMIT', 'the full private-check output could not be captured; restore its artifact storage before retrying'); transport.stop(); }
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { error = new Refused('RUNNER_OUTPUT_LIMIT', 'runner output exceeded 64 MiB; reduce command output or keep this run local'); transport.stop(); }
      else target.push(chunk);
    };
    child.stdout.on('data', chunk => capture(output, chunk, true));
    child.stderr.on('data', chunk => {
      capture(diagnostics, chunk);
      control += chunk.toString('utf8');
      // Budget: eight MiB of component receipts plus base64/JSON framing, inside the total 64-MiB bound.
      if (control.length > 16 * 1024 ** 2) { error = new Error('runner control frame exceeded limit'); transport.stop(); return; }
      let newline;
      while ((newline = control.indexOf('\n')) >= 0) {
        const line = control.slice(0, newline); control = control.slice(newline + 1);
        if (line === `PULLBOARD_RUNNER_READY ${request.spec.id}` && request.phase !== 'ready') {
          mark('ready'); heartbeatAt = Date.now(); clearTimeout(runnerWaitTimer); clearInterval(jobWatch); silence();
          try { deadline.ready(request.spec.trustedMode?.timeoutMs ?? request.spec.timeoutMs); }
          catch (failure) { error ??= failure; abort(); }
        }
        if (line === `PULLBOARD_RUNNER_HEARTBEAT ${request.spec.id}`) { heartbeatAt = Date.now(); if (request.phase === 'ready') silence(); }
        const cleanupPrefix = `PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${request.spec.id} `;
        if (line.startsWith(cleanupPrefix)) cleanupReason = line.slice(cleanupPrefix.length, cleanupPrefix.length + 240);
        const detailsPrefix = `PULLBOARD_RUNNER_CLEANUP_DETAILS ${request.spec.id} `;
        if (line.startsWith(detailsPrefix)) cleanupDetails = readCleanupTimeoutDetails(line.slice(detailsPrefix.length), request.spec.id);
        if (line === `PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${request.spec.id}`) {
          error = new Refused('RUNNER_CLEANUP_TIMEOUT', `runner ${request.runner.host} could not verify cleanup within 30 seconds${cleanupReason ? ': ' + cleanupReason : ''}${cleanupDetails ? '; waiting on ' + cleanupProcessText(cleanupDetails) : ''}; inspect job ${request.spec.id} under its runner namespace before another run`);
          error.diagnostic = runnerFailure(request, { status: null, stderr: '' }, 'cleanup-unverified').diagnostic;
          if (cleanupDetails) error.diagnostic.cleanup = cleanupDetails;
          transport.stop(); return;
        }
        // The receipt is the result: once it is in, the runner's cleanup runs on without this transport (#2538).
        if (line.startsWith(`PULLBOARD_RUNNER_RESULT ${request.spec.id} `) && !receiptSeen) {
          receiptSeen = true;
          receiptTimer = setTimeout(() => transport.stop(), RECEIPT_GRACE_MS);
        }
        const prefix = `PULLBOARD_RUNNER_NEED ${request.spec.id} `;
        if (!line.startsWith(prefix)) continue;
        if (requested) { error = new Error('duplicate runner inventory'); transport.stop(); return; }
        requested = true; mark('inventory');
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
          mark('pack');
          const pack = historyPack(root, request.source, inventory.tips, request.directory, request.spec.tags, inventory.tagObjects);
          await pipeline(createReadStream(pack), child.stdin);
          if (request.phase !== 'ready') mark('source-sent');
        })().catch(failure => { error ??= failure; transport.stop(); });
      }
    });
    child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
    child.once('error', failure => { error ??= failure; });
    child.stdin.write(request.frame);
    const waited = await transport.wait();
    let status = waited.status;
    const signal = waited.signal;
    clearTimeout(receiptTimer);
    // A transport ended by us after the receipt completed the job; resultFrom still authenticates that receipt.
    if (receiptSeen && !error && status !== 0) status = 0;
    jobCancellation.abort(); clearInterval(jobWatch); clearTimeout(heartbeatWatch);
    if (transfer) await transfer;
    if (error instanceof Refused) throw error;
    if (rawFd !== null) { closeSync(rawFd); rawFd = null; }
    const bounded = request.rawOutputPath ? Buffer.concat([head, ...(rawBytes > half * 2 ? [Buffer.from('\n[output capped at 8 MiB; middle omitted]\n')] : []), tail]) : Buffer.concat(output);
    return resultFrom(request, { status, signal, error, stdout: bounded, stderr: Buffer.concat(diagnostics),
      ...(request.rawOutputPath ? { rawOutputPath: request.rawOutputPath, rawBytes, rawSha256: rawHash.digest('hex') } : {}) }, ports);
  } finally {
    jobCancellation.abort(); clearInterval(jobWatch); clearTimeout(heartbeatWatch); transport?.dispose(); clearTimeout(runnerWaitTimer); if (rawFd !== null) closeSync(rawFd); removeAbort();
    request.cleanup();
  }
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
