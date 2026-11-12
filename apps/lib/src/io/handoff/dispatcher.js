#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../../../../../packages/gate/index.js';
import { finishAwaitingVerdicts } from '../../../../../packages/gate/index.js';
import {
  HANDOFF_DISPATCHER_OWNER_ENV,
  drainHandoffQueue,
  handoffDispatcherLog,
  handoffTicketsWaiting,
  handoffDispatcherMayBeDead,
  recoverHandoffDispatcher,
} from '../../../../../packages/resources/index.js';
import {
  createGateAdmission,
  gateDispatcherRow,
  mainOwnedVerdictPorts,
} from '../../../../../packages/drive/index.js';
import {
  closeBoard,
  launchServes,
  openBoard,
} from '../../../index.js';
import {
  currentCapacity,
  dispatcherPass as runnersDispatcherPass,
  handOver as runnersHandOver,
  liveCapacity,
  staleDispatcherTools as runnersStaleDispatcherTools,
} from '../../../../../packages/runners/index.js';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gitSpawnSync } from '../../../../../packages/git/light.js';
import { trunkRef } from '../../../../../packages/git/light.js';

/** How long one repository's sweep may run before the dispatcher moves on. */
const SWEEP_TIMEOUT_MS = 60_000;

/**
 * Sweep one repository's board for hand-offs whose worker is gone, in a child so a wedged board never stops dispatch.
 *
 * @param {string} commonDir - The repository's Git common directory.
 */
export async function sweepRepositoryInChild(commonDir) {
  const entry = fileURLToPath(new URL('../../../../cli/src/io/submit/handoff/sweep.js', import.meta.url));
  const child = spawn(process.execPath, [entry, commonDir], { stdio: ['ignore', 'ignore', 'inherit'], timeout: SWEEP_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`sweep exited ${code}`);
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
export const gateAdmission = createGateAdmission({ openBoard, closeBoard, serving: launchServes, entry: fileURLToPath(new URL('../../../../cli/src/io/gate/drive.js', import.meta.url)) });

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

/**
 * The commit a tool root's trunk branch names (its HEAD only when no trunk is recorded), or null when it has none; runs
 * git here, in the bin, never in a cell the leases reach. Why the trunk: seats submit from their own worktrees, each
 * at its item's HEAD, so on 11 Nov every seat's launch looked current and dispatchers handed over to each other every
 * few seconds, cutting each gate's lifeline 2-4 times before any test ran; only main's tip is current tooling (DJ16).
 */
export function toolRootHead(root) {
  let trunk = null;
  try { trunk = trunkRef(root); } catch { return null; }
  const run = gitSpawnSync(['-C', root, 'rev-parse', '--verify', '--quiet', trunk ? `refs/heads/${trunk}^{commit}` : 'HEAD'], { encoding: 'utf8' });
  return run.status === 0 && /^[0-9a-f]{40}$/u.test(run.stdout.trim()) ? run.stdout.trim() : null;
}

/** The current tools this dispatcher should hand over to, or null while it runs them (the runners cell's rule, on git here). */
export function staleDispatcherTools(ports = {}) { return runnersStaleDispatcherTools({ head: toolRootHead, ...ports }); }

/**
 * The dispatcher's per-pass work (the runners cell's), finishing verdicts that wait on main through the gate cell on
 * the drive cell's ports [C7,#3534].
 *
 * @param {{ renew: () => (boolean | void), withDb: Function }} row - This dispatcher's job row.
 * @param {{ now?: () => number, finish?: typeof finishAwaitingVerdicts, stale?: () => string | null }} [options]
 * @returns {() => void}
 */
export function dispatcherPass(row, { finish = finishAwaitingVerdicts, stale = staleDispatcherTools, ...options } = {}) {
  return runnersDispatcherPass(row, { ...options, stale, finish: db => finish(mainOwnedVerdictPorts(), db) });
}

/** Hand the machine over (the runners cell's), launching the successor with the gate cell's exact process start (DJ16). */
export function handOver(tools, exit, ports = {}) { return runnersHandOver(tools, exit, { startOf: exactStart, ...ports }); }

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
