import { committedRunnerController } from './tooling/committed.js';
import { runnerControllerEntry } from './tooling/committed.js';

/** How often a waiting controller re-reads its runner's lease before the job is READY. */
const LEASE_WATCH_MS = 5_000;
/** Dispatch runner work through a fresh controller process and hold its SSH session [C7]. */
import { RunnerDropped } from '../../../gate/light.js';
import { Refused } from '../../../kernel/index.js';
import { historyPack } from './pack.js';
import { requestFor } from './request.js';
import { forgetRuntimeHeld } from './runtime.js';
import { recordRuntimeHeld } from './runtime.js';
import { spawnSsh } from '../../../transport/index.js';
import { resultFrom } from './result.js';
import { runnerFailure } from './result.js';
import { readCleanupTimeoutDetails } from '../logic/diagnostics.js';
import { cleanupProcessText } from '../logic/diagnostics.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { openSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { MAX_OUTPUT_BYTES } from './bridge.js';
import { RUN_CEILING_MS } from './bridge.js';
import { bridgeResult } from './bridge.js';
import { runCeilingMs } from './bridge.js';
import { runnerUnavailableRefusal } from './bridge.js';
import { startupDeadline } from './bridge.js';
import { ownedTransportCompletion } from '../../../transport/index.js';
import { bridgeDeadlineMs } from './run-async.js';
export { MAX_OUTPUT_BYTES } from './bridge.js';
export { RUN_CEILING_MS } from './bridge.js';
export { bridgeResult } from './bridge.js';
export { runCeilingMs } from './bridge.js';
export { runnerUnavailableRefusal } from './bridge.js';
export { startupDeadline } from './bridge.js';
export { ownedTransportCompletion } from '../../../transport/index.js';
import { controllerWake } from './controller/watch.js';
import { PARENT_PIPE_FD } from './controller/watch.js';


// Budget: after the receipt, wait this long for the last output bytes before ending the transport; the worker finishes cleanup on its own.
const RECEIPT_GRACE_MS = 500;

/** Keep synchronous callers on the same fresh controller entry without a second bridge. */
export function runOnRunner(root, command, options) {
  const request = { root, command, options, parentPid: process.pid, parentPipe: PARENT_PIPE_FD };
  const installation = committedRunnerController(fileURLToPath(new URL('../../../../', import.meta.url)), { shared: true });
  try {
  const child = spawnSync(process.execPath, [installation?.entry ?? runnerControllerEntry(fileURLToPath(new URL('../../../../', import.meta.url))), '--pullboard-runner-controller'], {
    cwd: root, env: { ...process.env }, input: JSON.stringify(request), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES * 6 + 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    ...(bridgeDeadlineMs(options) ? { timeout: bridgeDeadlineMs(options), killSignal: 'SIGKILL' } : {}),
  });
  return bridgeResult(request, child, 'sync-bridge');
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

/** Negotiate missing history objects while the remote cache lease stays held in one SSH session. */
async function runInController(root, command, options, ports) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  // When the controller began preparing the request and when it was ready, so the source scans before connecting are spans [C7].
  const preparing = Date.now();
  const request = await requestFor(root, command, options, ports);
  const prepared = Date.now();
  const deadline = ports.controllerCustody;
  deadline?.job?.(request.spec.recovery);
  let removeAbort = () => {};
  let runnerWaitTimer, runCeilingTimer;
  let jobWatch, heartbeatWatch, transport, receiptSeen = false, receiptTimer;
  const jobCancellation = new AbortController();
  let rawFd = null;
  try {
    if (request.rawOutputPath) rawFd = openSync(request.rawOutputPath, 'wx', 0o600);
    /** Record when each dispatch phase began, so a slow shard names its slow step [C7]. */
    const mark = phase => { request.phase = phase; (request.phaseAt ??= { start: Date.now() })[phase] = Date.now(); };
    mark('connect');
    Object.assign(request.phaseAt, { prepare: preparing, prepared });
    const child = spawnSsh(request.args, { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const readyDeadline = startupDeadline(options, request.phaseAt.start);
    if (readyDeadline !== null) runnerWaitTimer = setTimeout(() => {
      request.admissionDeadlineExceeded = true;
      abort();
    }, Math.max(0, readyDeadline - Date.now()));
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
          recordRuntimeHeld(request.runner?.host, request.spec.tooling?.sha256); // Its next launch sends no runtime bytes (#4140).
          const ceiling = runCeilingMs(request.spec);
          if (ceiling !== null) runCeilingTimer = setTimeout(() => {
            if (receiptSeen || error) return;
            const last = Buffer.concat(output).toString('utf8').trimEnd().split('\n').slice(-5).join('\n').slice(-600);
            error = new Refused('RUNNER_RUN_TIMEOUT', `the run on ${request.runner.host} passed its ${Math.round(ceiling / 60_000)}-minute ceiling with no result, so a test hangs; it was stopped and is not retried. Its last output:\n${last || '(none)'}\nFind the hanging test, make it finish, commit, and submit again`);
            error.diagnostic = runnerFailure(request, { status: null, stderr: '' }, 'run-ceiling').diagnostic;
            transport.stop();
          }, ceiling);
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
    // A reused runtime that never reached READY may be gone or changed: the next launch sends the full capsule (#4140).
    if (request.reusedRuntime && request.phase !== 'ready') forgetRuntimeHeld(request.runner?.host, request.spec.tooling?.sha256);
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
    jobCancellation.abort(); clearInterval(jobWatch); clearTimeout(heartbeatWatch); transport?.dispose(); clearTimeout(runnerWaitTimer); clearTimeout(runCeilingTimer); if (rawFd !== null) closeSync(rawFd); removeAbort();
    request.cleanup();
  }
}
