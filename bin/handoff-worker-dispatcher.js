#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../packages/gate/index.js';
import { finishAwaitingVerdicts } from '../packages/gate/index.js';
import { HANDOFF_DISPATCHER_OWNER_ENV, drainHandoffQueue, ensureHandoffDispatcher, finishRunningWorkers, handoffDispatcherLog, handoffQueueDirectory, handoffTicketsWaiting, handoffWorkerCapacityDetail, handoffDispatcherMayBeDead, recordHandoffCap, recoverHandoffDispatcher } from '../packages/resources/index.js';
import { createGateAdmission, gateDispatcherRow, mainOwnedVerdictPorts } from '../packages/drive/index.js';
import { closeBoard, openBoard } from '../apps/lib/index.js';
import { loadMachineSettings } from '../packages/config/index.js';
import { effectiveRunners } from '../packages/runners/index.js';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

/** How long one repository's sweep may run before the dispatcher moves on. */
const SWEEP_TIMEOUT_MS = 60_000;

/**
 * Sweep one repository's board for hand-offs whose worker is gone, in a child so a wedged board never stops dispatch.
 *
 * @param {string} commonDir - The repository's Git common directory.
 */
export async function sweepRepositoryInChild(commonDir) {
  const entry = join(fileURLToPath(new URL('..', import.meta.url)), 'apps', 'cli', 'src', 'shell', 'submit-handoff-sweep.js');
  const child = spawn(process.execPath, [entry, commonDir], { stdio: ['ignore', 'ignore', 'inherit'], timeout: SWEEP_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`sweep exited ${code}`);
}

/** The worker cap and its origin from the current machine settings; unreadable settings count as no runners, leaving the local cap. */
export function currentCapacityDetail(env = {}) {
  // The dispatcher is launched by whichever seat submits first and would inherit that seat's environment: on 6 Nov a
  // seat script exporting PULLBOARD_HANDOFF_WORKERS=6 capped the whole machine at 6 workers for six hours while 54
  // gates queued and 41 runner slots sat free. The machine's cap comes from its settings; an override is passed in
  // explicitly, never read from the inherited environment [C7].
  let settings;
  try { settings = loadMachineSettings(); }
  catch { return handoffWorkerCapacityDetail({ env }); /* no runners readable: the local core cap still applies */ }
  // The machine setting gate.handoffWorkers is the one durable way to lower the cap; it reads from the machine's own settings file, so every launch sees the same number [C7].
  const machineCap = settings.gate?.handoffWorkers; // Applied inside handoffWorkerCapacityDetail, the one place the cap is decided [C7].
  let runnerSlots = 0;
  try { runnerSlots = effectiveRunners(settings).reduce((sum, runner) => sum + runner.slots, 0); }
  catch { runnerSlots = 0; /* no runners readable: the local core cap still applies */ }
  return handoffWorkerCapacityDetail({ env, runnerSlots, runnersOnly: settings.gate?.runnersOnly === true, machineCap });
}

/** The worker cap number from the current machine settings. */
export function currentCapacity(env = {}) { return currentCapacityDetail(env).cap; }

/** The live cap number, recording it and its origin for pullboard status. */
export function liveCapacity(env = {}) {
  const detail = currentCapacityDetail(env);
  recordHandoffCap(detail);
  return detail.cap;
}

/**
 * Say why the dispatcher is dying, on stderr and in the dispatcher log, with the capacity it computed.
 * Why: the dispatcher runs detached, so on 6 Nov every one died at once on BAD_RESOURCE_CAPACITY with nothing in the log [C7,#3302].
 *
 * @param {Error & { code?: string }} error - What the drain pass threw.
 * @param {() => number} [capacity] - The cap function the pass used.
 */
export function reportDispatcherFailure(error, capacity = currentCapacity) {
  let value;
  try { value = capacity(); } catch (failure) { value = `unreadable (${failure.message})`; }
  const line = `dispatcher failed: ${error.code ?? 'ERROR'}: ${error.message} (capacity ${value})`;
  process.stderr.write(line + '\n');
  try { appendFileSync(handoffDispatcherLog(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); }
  catch { /* an unwritable log still leaves stderr and the non-zero exit */ }
}

/**
 * The drive cell's admission for the dispatcher, on this tree's board opener: each gate is admitted to a driver id on
 * its board before its driver starts, the started process is recorded on the gate's drive job, and a driver that
 * cannot start is recorded there as unstarted. Nothing is written beside the hand-off [C7].
 */
export const gateAdmission = createGateAdmission({ openBoard, closeBoard, entry: fileURLToPath(new URL('./gate-drive-worker.js', import.meta.url)) });

/**
 * The dispatcher's job row on the board that launched it: renewed at most every 5 seconds, freed on exit.
 *
 * @param {string} commonDir - The launching repository's common directory, the dispatcher's working directory.
 * @param {string | undefined} owner - The lease owner the launching submit took the row for.
 * @returns {{ renew: () => void, release: () => void }}
 */
export function dispatcherRow(commonDir, owner) {
  return gateDispatcherRow({ openBoard, closeBoard }, commonDir, owner);
}

/**
 * Whether a ticket arrived after the drain's last look and this dispatcher took its freed row back to drain it.
 * Why: a submit that queued while this row was still held launched no dispatcher, so without one more look its gate
 * sat queued with nobody to start it (#3495). A submit that saw the row free took it and launched its own, and then
 * the retake fails; a deferred drain leaves the queue to the dispatcher holding the machine, which looks again itself.
 *
 * @param {{ deferred?: true }} drained - What the finished drain returned.
 * @param {{ retake: () => boolean }} row - This dispatcher's job row, already freed.
 * @returns {boolean}
 */
export function lateTicketRetaken(drained, row) {
  if (drained.deferred) return false;
  try { return handoffTicketsWaiting() && row.retake(); }
  catch { return false; /* an unreadable queue or board is left to the next submit's launch */ }
}

/** The tools folder this dispatcher runs from. */
const OWN_TOOLS = fileURLToPath(new URL('..', import.meta.url));

/** How often a dispatcher checks that it runs its tool root's current tooling; the check runs git, so not every pass. */
const TOOLS_CHECK_MS = 30_000;

/** The launches waiting in line, as their tickets name them; unreadable tickets are left to the drain to report. */
function waitingLaunches() {
  let names;
  try { names = readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.json$/u.test(name)).sort(); }
  catch { return []; }
  const launches = [];
  for (const name of names) {
    try { launches.push(JSON.parse(readFileSync(join(handoffQueueDirectory(), name), 'utf8'))); }
    catch { /* the drain reports a ticket it cannot read */ }
  }
  return launches;
}

/** A shared tools snapshot's folder name: one per tooling tree. */
const SHARED_TOOLS = /^pullboard-handoff-tools-[0-9a-f]{40}$/u;

/** The commit a tool root's HEAD names, or null when it has none. */
function toolRootHead(root) {
  const run = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return run.status === 0 && /^[0-9a-f]{40}$/u.test(run.stdout.trim()) ? run.stdout.trim() : null;
}

/**
 * The current tools this dispatcher should hand over to, or null while it runs them. The newest waiting launch whose
 * request was captured at its tool root's current HEAD names the current tooling snapshot; a dispatcher running a
 * different shared snapshot hands over to it. A dispatcher run from a checkout, or with no launch captured at the
 * current HEAD, never hands over.
 *
 * Why: on 8 Nov a dispatcher started from submit-time tools kept launching gates on code main had fixed (no
 * PROOF_MAX_SHARDS), and one gate opened 18 runner controllers; one live dispatcher must run main's tooling (DJ16).
 *
 * @param {{ own?: string, launches?: () => { directory: string, tools: string }[], head?: (root: string) => string | null }} [ports]
 * @returns {string | null} The current tools folder to hand over to.
 */
export function staleDispatcherTools({ own = OWN_TOOLS, launches = waitingLaunches, head = toolRootHead } = {}) {
  if (!SHARED_TOOLS.test(basename(own))) return null;
  for (const launch of [...launches()].reverse()) {
    let request;
    try { request = JSON.parse(readFileSync(join(launch.directory, 'request.json'), 'utf8')); } catch { continue; }
    if (typeof request.toolRoot !== 'string' || typeof launch.tools !== 'string' || !SHARED_TOOLS.test(basename(launch.tools))) continue;
    if (!existsSync(launch.tools) || request.toolsCommit !== head(request.toolRoot)) continue;
    try { return realpathSync(launch.tools) === realpathSync(own) ? null : launch.tools; } catch { return null; }
  }
  return null;
}

/** How often a dispatcher pass looks for gate verdicts waiting on main: the row's own renewal cadence. */
const VERDICT_PASS_MS = 5_000;

/**
 * Build the dispatcher's per-pass work: renew its row, and at most every VERDICT_PASS_MS finish every gate verdict
 * waiting on main whose main-test jobs have returned (the gate cell's finishAwaitingVerdicts). Why: a verdict that
 * waits on main is a board row, not a waiting process; the drive loop finishes it, so no item goes back to its builder
 * for a red main owns [C7,#3534].
 *
 * @param {{ renew: () => void, withDb: Function }} row - This dispatcher's job row.
 * @param {{ now?: () => number, finish?: typeof finishAwaitingVerdicts }} [options]
 * @returns {() => void}
 */
export function dispatcherPass(row, { now = Date.now, finish = finishAwaitingVerdicts, stale = staleDispatcherTools } = {}) {
  let lookedAt = 0;
  let toolsAt = 0;
  return () => {
    // Another dispatcher took the row: stop launching at once and leave the machine to it (DJ16).
    if (row.renew() === false) throw Object.assign(new Error('another dispatcher holds the dispatcher row'), { code: 'DISPATCHER_REPLACED', tools: null, handOver: true });
    if (now() - toolsAt >= TOOLS_CHECK_MS) {
      toolsAt = now();
      const tools = stale();
      // Stop launching: the drain frees the machine's lock on the way out, and runDispatcher hands over to these tools.
      if (tools) throw Object.assign(new Error(`this dispatcher runs ${OWN_TOOLS}; current tooling is ${tools}`), { code: 'DISPATCHER_TOOLS_STALE', tools, handOver: true });
    }
    if (now() - lookedAt < VERDICT_PASS_MS) return;
    lookedAt = now();
    row.withDb(db => finish(mainOwnedVerdictPorts(), db));
  };
}

/** Failures a drain pass can meet from a busy disk or a busy writer: the pass is retried, never the dispatcher ended. */
export const TRANSIENT_DRAIN_ERRORS = new Set(['SLOT_DB_LOCKED', 'BOARD_BUSY']);

/** The first wait before a drain pass that met a transient failure runs again; it doubles up to DRAIN_RETRY_MAX_MS. */
export const DRAIN_RETRY_MS = 1_000;

/** The longest wait between retried drain passes. */
export const DRAIN_RETRY_MAX_MS = 30_000;

/**
 * Drain the hand-off queue until it is empty, as the detached dispatcher process does. A pass that throws a transient
 * failure (TRANSIENT_DRAIN_ERRORS) is logged and run again after a backoff that doubles from DRAIN_RETRY_MS to
 * DRAIN_RETRY_MAX_MS, keeping the workers already started, so a locked slot database never ends the dispatcher. Any
 * other failure is reported and ends the process. The workers it started hold their own slots and run on through
 * any exit of this process.
 *
 * Why: on 8 Nov the dispatcher died on SLOT_DB_LOCKED six times in 95 minutes ("stayed locked for 10005ms"), and
 * about 22 gates ended SUBMIT_HANDOFF_DEAD after those deaths; a busy disk on one laptop has the same lock (#3717) [C7].
 *
 * @param {{ row?: { renew: () => void, release: () => void, retake: () => boolean, withDb: Function },
 *   drain?: typeof drainHandoffQueue, admission?: object, onPass?: () => void, retryMs?: number, maxRetryMs?: number,
 *   exit?: (code: number) => void }} [ports] - The dispatcher's job row and the drain; tests pass stand-ins for the board.
 * @returns {Promise<void>}
 */
export async function runDispatcher({ row = dispatcherRow(process.cwd(), process.env[HANDOFF_DISPATCHER_OWNER_ENV]), drain = drainHandoffQueue,
  admission = gateAdmission, onPass = dispatcherPass(row), retryMs = DRAIN_RETRY_MS, maxRetryMs = DRAIN_RETRY_MAX_MS, exit = code => process.exit(code) } = {}) {
  const running = new Map();
  let again;
  let backoff = retryMs;
  do {
    let drained;
    try { drained = await drain({ startOf: exactStart, capacity: liveCapacity, sweep: sweepRepositoryInChild, admission, onPass, running }); }
    catch (error) {
      if (error?.handOver) { await handOver(error.tools, exit, { running }); return; }
      if (TRANSIENT_DRAIN_ERRORS.has(error?.code)) {
        reportDispatcherRetry(error, backoff);
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, maxRetryMs);
        again = true;
        continue;
      }
      // The drain released its lock on the way out; exit now so a detached worker handle cannot keep a dead loop alive.
      reportDispatcherFailure(error);
      try { row.release(); } catch { /* a board that cannot be written lets the row lapse in 2 minutes */ }
      exit(1);
      return;
    }
    backoff = retryMs;
    // The queue is empty: free the row so the next submit launches a dispatcher at once.
    try { row.release(); } catch { /* a board that cannot be written lets the row lapse in 2 minutes */ }
    again = lateTicketRetaken(drained, row);
  } while (again);
}

/**
 * Hand the machine over, then exit once the gates this dispatcher started have finished. With current tools, launch
 * one from them in this directory under this dispatcher's own row owner, so the successor holds the row it renewed;
 * with none, another dispatcher already took the row. Either way this one launches nothing more and frees each of
 * its workers' slots as they exit (DJ16).
 *
 * @param {string | null} tools - The current tools folder, or null when another dispatcher took over.
 * @param {(code: number) => void} exit
 * @param {{ launch?: typeof ensureHandoffDispatcher, running?: Map<unknown, object>, finish?: typeof finishRunningWorkers, owner?: string }} [ports]
 */
export async function handOver(tools, exit, { launch = ensureHandoffDispatcher, running = new Map(), finish = finishRunningWorkers, owner = process.env[HANDOFF_DISPATCHER_OWNER_ENV] } = {}) {
  const line = tools ? `dispatcher on ${OWN_TOOLS} hands over to current tooling ${tools}` : `dispatcher on ${OWN_TOOLS} stops: another dispatcher took the row`;
  // The dispatcher's stderr is its log, so the hand-over is recorded there.
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  if (tools) {
    try { await launch(tools, process.cwd(), { startOf: exactStart, ...(owner ? { owner } : {}) }); }
    catch (error) { process.stderr.write(`hand-over launch failed: ${error.message}; the next submit launches a dispatcher\n`); }
  }
  await finish(running);
  exit(0);
}

/**
 * Say that a drain pass met a transient failure and when it runs again, on stderr and in the dispatcher log.
 *
 * @param {Error & { code?: string }} error - What the drain pass threw.
 * @param {number} waitMs - How long the dispatcher waits before the next pass.
 */
export function reportDispatcherRetry(error, waitMs) {
  const line = `dispatcher pass interrupted: ${error.code}: ${error.message}; retrying in ${waitMs}ms`;
  process.stderr.write(line + '\n');
  try { appendFileSync(handoffDispatcherLog(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); }
  catch { /* an unwritable log still leaves stderr, and the retry itself still happens */ }
}

/** The argument that runs the detached recovery check a board command starts instead of the drain. */
export const RECOVER_ARG = '--recover';

/**
 * The background recovery job a board command starts detached: when a launch is queued and no dispatcher heartbeat
 * is fresh, relaunch the dispatcher from the queued launch's captured tooling unless a live one holds the machine's
 * lock. Nobody waits on it, so a failure is written to the dispatcher log [C7].
 *
 * @param {{ mayBeDead?: () => boolean, recover?: typeof recoverHandoffDispatcher }} [ports]
 * @returns {Promise<void>}
 */
export async function runRecoveryCheck({ mayBeDead = handoffDispatcherMayBeDead, recover = recoverHandoffDispatcher } = {}) {
  try { if (mayBeDead()) await recover({ loadStartOf: async () => exactStart }); }
  catch (error) {
    try { appendFileSync(handoffDispatcherLog(), `${new Date().toISOString()} recovery check failed: ${error.code ?? error.name}: ${error.message}\n`, { mode: 0o600 }); }
    catch { /* an unwritable log leaves the next command's check to try again */ }
    process.exitCode = 1;
  }
}

// The cap is read on every dispatch pass, so a raised runner fleet or runnersOnly takes effect without a restart.
// Only a direct launch drains; importing this file to read its cap (as the test does) starts nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) await (process.argv[2] === RECOVER_ARG ? runRecoveryCheck() : runDispatcher());
