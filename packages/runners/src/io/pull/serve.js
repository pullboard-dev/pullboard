/** The short controller modes of a pulled job: submit, serve-need and finish, each its own brief process [C7,#5465]. */
import { Refused } from '../../../../kernel/index.js';
import { historyPack } from '../pack.js';
import { exchangeStore } from '../request.js';
import { requestFor } from '../request.js';
import { resultFrom } from '../result.js';
import { runnerFailure } from '../result.js';
import { runCeilingMs } from '../dispatch.js';
import { runnerUnavailableRefusal } from '../dispatch.js';
import { startupDeadline } from '../dispatch.js';
import { packDirectory } from './jobs.js';
import { readJob } from './jobs.js';
import { removeJob } from './jobs.js';
import { updateJob } from './jobs.js';
import { writeJob } from './jobs.js';
import { MAX_FETCH_BYTES } from './transfer.js';
import { ackScript } from './transfer.js';
import { burstOk } from './transfer.js';
import { cancelScript } from './transfer.js';
import { enqueueScript } from './scripts.js';
import { fetchScript } from './scripts.js';
import { packScript } from './scripts.js';
import { sshBurst } from './transfer.js';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { openSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeSync } from 'node:fs';

/** The modes a pull-aware controller entry accepts after `--pullboard-runner-controller`. */
export const PULL_MODES = ['--submit', '--serve-need', '--finish'];

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Keep the history-pack inventory to the shapes the controller always accepted. */
function checkedInventory(encoded) {
  const inventory = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'));
  if (!Array.isArray(inventory.tips) || inventory.tips.length > 1024 || inventory.tips.some(tip => typeof tip !== 'string' || !SHA.test(tip))) throw new Error('invalid runner inventory');
  if (!Array.isArray(inventory.tagObjects) || inventory.tagObjects.length > 8_192 || inventory.tagObjects.some(object => typeof object !== 'string' || !SHA.test(object))) throw new Error('invalid runner tag inventory');
  return inventory;
}

/**
 * Build and scan the request, enqueue it on its runner and keep a durable record; the job then runs without this process.
 * Why: the controller held one ssh session for the whole run; submit holds it for the enqueue only.
 *
 * @param {{ root: string, command: string, options: object, parentPid: number }} payload
 * @param {object} ports - The controller's private-check ports.
 * @returns {Promise<object>} What the caller needs to wait: id, recovery, host, deadlines.
 */
export async function submitJob(payload, ports) {
  const preparing = Date.now();
  const request = await requestFor(payload.root, payload.command, payload.options, ports);
  const prepared = Date.now();
  try {
    const mark = phase => { request.phase = phase; (request.phaseAt ??= { start: Date.now() })[phase] = Date.now(); };
    mark('connect');
    Object.assign(request.phaseAt, { prepare: preparing, prepared });
    if (request.rawOutputPath) closeSync(openSync(request.rawOutputPath, 'wx', 0o600));
    const job = { version: 1, id: request.spec.id, runner: request.runner, spec: { ...request.spec, ...(request.spec.testResults ? { testResults: { ...request.spec.testResults, packet: null } } : {}) },
      phaseAt: request.phaseAt, phase: request.phase, root: request.root, source: request.source, args: request.args,
      ...(request.rawOutputPath ? { rawOutputPath: request.rawOutputPath } : {}), reusedRuntime: request.reusedRuntime, hasExchange: Boolean(request.exchange),
      startupDeadline: startupDeadline(payload.options, request.phaseAt.start), ceilingMs: runCeilingMs(request.spec),
      readyTimeoutMs: request.spec.trustedMode?.timeoutMs ?? request.spec.timeoutMs ?? null, parentPid: payload.parentPid, item: String(payload.options.metadata?.item ?? '') };
    const row = JSON.stringify({ version: 1, id: job.id, recovery: request.spec.recovery, toolingSha256: request.spec.tooling.sha256, enqueuedAt: Date.now(), rawOutput: Boolean(request.rawOutputPath) });
    const script = enqueueScript(request.runner, { id: job.id, frameBytes: request.frame.length, command: request.args.at(-1), agent: ports.agentStart?.(request.runner.root ?? '') ?? '' });
    const sent = await sshBurst({ args: request.args, env: request.env }, script, { input: Buffer.concat([Buffer.from(`${row}\n`), request.frame]) });
    if (!burstOk(sent)) throw runnerFailure(request, { status: sent.status, signal: sent.signal, error: sent.error, stderr: sent.stderr }, 'enqueue');
    writeJob(job);
    return { id: job.id, recovery: job.spec.recovery, host: request.runner.host, toolingSha: request.spec.tooling.sha256, reusedRuntime: job.reusedRuntime,
      startupDeadline: job.startupDeadline, ceilingMs: job.ceilingMs, readyTimeoutMs: job.readyTimeoutMs, phaseAt: job.phaseAt };
  } finally { request.cleanup(); }
}

/**
 * Answer the runner's NEED for history: pack exactly what its inventory lacks and upload it, then mark it complete.
 * The only secret and size scan of the pack is `historyPack`, as in the controller.
 */
export async function serveNeed({ id, inventory }) {
  const job = readJob(id);
  const { tips, tagObjects } = checkedInventory(inventory);
  const directory = packDirectory();
  try {
    updateJob(id, { phaseAt: { inventory: Date.now() } });
    const packed = Date.now();
    const pack = historyPack(job.root, job.source, tips, directory, job.spec.tags, tagObjects);
    const sent = await sshBurst(job, packScript(job.runner, { id, bytes: statSync(pack).size }), { inputFile: pack });
    if (!burstOk(sent)) throw runnerFailure(job, { status: sent.status, signal: sent.signal, error: sent.error, stderr: sent.stderr }, 'pack-upload');
    updateJob(id, { phaseAt: { pack: packed, 'source-sent': Date.now() } });
    return { sent: true };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/**
 * Read one finished-job file, trying up to three times: a fetch is a read, and one transport hiccup under many concurrent
 * jobs must not read as an empty file (a missing receipt would then look like a dropped runner).
 */
async function fetchBurst(job, name) {
  let got;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    got = await sshBurst(job, fetchScript(job.runner, { id: job.id, name }));
    if (burstOk(got)) return got;
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return got;
}

/** Stream a finished job's private-check output to its capture file, keeping the controller's hash and 8 MiB head and tail. */
async function captureRaw(job) {
  const fd = openSync(job.rawOutputPath, 'w', 0o600);
  const hash = createHash('sha256'), half = 4 * 1024 ** 2;
  let bytes = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0), failed = false;
  try {
    const got = await sshBurst(job, fetchScript(job.runner, { id: job.id, name: 'out.bin' }), { onStdout: chunk => {
      if (failed) return;
      try {
        for (let offset = 0; offset < chunk.length;) {
          const written = writeSync(fd, chunk, offset, chunk.length - offset);
          if (written <= 0) throw new Error('private-check output made no capture progress');
          offset += written;
        }
        hash.update(chunk); bytes += chunk.length;
        const take = Math.min(chunk.length, half - head.length);
        if (take) head = Buffer.concat([head, chunk.subarray(0, take)]);
        if (chunk.length > take) tail = Buffer.concat([tail, chunk.subarray(take)]).subarray(-half);
      } catch { failed = true; }
    } });
    if (failed) throw new Refused('RUNNER_OUTPUT_LIMIT', 'the full private-check output could not be captured; restore its artifact storage before retrying');
    return { got, bounded: Buffer.concat([head, ...(bytes > half * 2 ? [Buffer.from('\n[output capped at 8 MiB; middle omitted]\n')] : []), tail]), extra: { rawOutputPath: job.rawOutputPath, rawBytes: bytes, rawSha256: hash.digest('hex') } };
  } finally { closeSync(fd); }
}

/**
 * Fetch a job's output and control log, run the unchanged result check and return its answer or refusal; the record and the
 * runner's copy are then removed. `reason` says how the wait ended: result, ssh-exit, admission-deadline, run-timeout,
 * canceled, job-lost, unavailable or source-changed; each maps to the failure the controller raised for it.
 *
 * @param {{ id: string, reason: string, exit?: { code: number|null, signal: string|null }, readyAt?: number, owner?: object, unavailable?: object, cancellation?: object }} payload
 * @param {{ privateCheckPhases: Function }} ports
 */
export async function finishJob(payload, ports) {
  const job = readJob(payload.id);
  const { reason } = payload;
  const request = { spec: job.spec, runner: job.runner, args: job.args, root: job.root, source: job.source, phaseAt: job.phaseAt, phase: payload.readyAt ? 'ready' : job.phase,
    reusedRuntime: job.reusedRuntime, ...(job.rawOutputPath ? { rawOutputPath: job.rawOutputPath } : {}) };
  if (payload.readyAt) request.phaseAt = { ...request.phaseAt, ready: payload.readyAt };
  if (job.hasExchange) request.exchange = { store: await exchangeStore(job.root) };
  try {
    if (reason !== 'result' && reason !== 'ssh-exit') await sshBurst(job, cancelScript(job.runner, job.id));
    const control = await fetchBurst(job, 'control.log');
    let output, raw = {}, fetched = control;
    if (job.rawOutputPath) { const captured = await captureRaw(job); output = captured.bounded; raw = captured.extra; fetched = captured.got.error ? captured.got : control; }
    else { const body = await fetchBurst(job, 'out.bin'); output = body.stdout; fetched = body.error ? body : control; }
    if (fetched.error?.code === 'RUNNER_OUTPUT_LIMIT') throw new Refused('RUNNER_OUTPUT_LIMIT', fetched.error.message);
    const stderr = control.stdout;
    const receiptSeen = stderr.toString('utf8').split('\n').some(line => line.startsWith(`PULLBOARD_RUNNER_RESULT ${job.id} `));
    let error = fetched.error;
    if (reason === 'admission-deadline') request.admissionDeadlineExceeded = true;
    if (['admission-deadline', 'canceled', 'source-changed', 'unavailable'].includes(reason)) error ??= new Error('runner transport canceled');
    if (reason === 'run-timeout') {
      const last = output.toString('utf8').trimEnd().split('\n').slice(-5).join('\n').slice(-600);
      const ceiling = job.ceilingMs;
      const refused = new Refused('RUNNER_RUN_TIMEOUT', `the run on ${job.runner.host} passed its ${Math.round(ceiling / 60_000)}-minute ceiling with no result, so a test hangs; it was stopped and is not retried. Its last output:\n${last || '(none)'}\nFind the hanging test, make it finish, commit, and submit again`);
      refused.diagnostic = runnerFailure(request, { status: null, stderr: '' }, 'run-ceiling').diagnostic;
      throw refused;
    }
    if (reason === 'job-lost') {
      const refused = new Refused('RUNNER_JOB_LOST', `runner ${job.runner.host} lost exact job ${job.id}: its recorded startup owner is gone; remote cleanup remains unknown`);
      refused.diagnostic = { ...runnerFailure(request, { status: null, stderr: '' }, 'job-owner-gone').diagnostic, host: job.runner.host, job: job.id, owner: payload.owner, remoteCleanup: 'unknown' };
      throw refused;
    }
    if (reason === 'unavailable') throw runnerUnavailableRefusal(request, payload.unavailable);
    let status = payload.exit?.code ?? null;
    if (receiptSeen && !error && status !== 0) status = 0;
    try { return resultFrom(request, { status, signal: payload.exit?.signal ?? null, error, stdout: output, stderr, ...raw }, ports); }
    catch (original) {
      if (reason !== 'source-changed') throw original;
      const refused = new Refused('RUNNER_SOURCE_CHANGED', `controller stopped: ${payload.cancellation.reason} (${payload.cancellation.root})`);
      refused.runnerCancellation = { ...payload.cancellation, diagnostic: original.diagnostic ?? { reason: 'source-cancelled', phase: 'controller' } };
      throw refused;
    }
  } finally {
    removeJob(job.id);
    await sshBurst(job, ackScript(job.runner, job.id)).catch(() => {});
  }
}

/** Read the JSON request from stdin, run one mode and write the same `{result}` or `{error}` envelope the controller does. */
export async function servePullController(mode, ports) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const payload = JSON.parse(input);
    const result = mode === '--submit' ? await submitJob(payload, ports) : mode === '--serve-need' ? await serveNeed(payload) : await finishJob(payload, ports);
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: { name: error.name, code: error.code, message: error.message, host: error.host, runnerAttempt: error.runnerAttempt, diagnostic: error.diagnostic,
      runnerCancellation: error.runnerCancellation, workSpecVersions: error.workSpecVersions } }));
    process.exitCode = 1;
  }
}
