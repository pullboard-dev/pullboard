#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../packages/gate/index.js';
import { finishAwaitingVerdicts } from '../packages/gate/index.js';
import { HANDOFF_DISPATCHER_OWNER_ENV, drainHandoffQueue, handoffDispatcherLog, handoffTicketsWaiting, handoffWorkerCapacityDetail, recordHandoffCap } from '../packages/resources/index.js';
import { createGateAdmission, gateDispatcherRow, mainOwnedVerdictPorts } from '../packages/drive/index.js';
import { closeBoard, openBoard } from '../apps/lib/index.js';
import { loadMachineSettings } from '../packages/config/index.js';
import { effectiveRunners } from '../packages/runners/index.js';
import { appendFileSync } from 'node:fs';
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
  const machineCap = settings.gate?.handoffWorkers;
  if (Number.isSafeInteger(machineCap) && machineCap >= 1 && env.PULLBOARD_HANDOFF_WORKERS === undefined) return { cap: machineCap, source: 'gate.handoffWorkers machine setting' };
  let runnerSlots = 0;
  try { runnerSlots = effectiveRunners(settings).reduce((sum, runner) => sum + runner.slots, 0); }
  catch { runnerSlots = 0; /* no runners readable: the local core cap still applies */ }
  return handoffWorkerCapacityDetail({ env, runnerSlots, runnersOnly: settings.gate?.runnersOnly === true });
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
export function dispatcherPass(row, { now = Date.now, finish = finishAwaitingVerdicts } = {}) {
  let lookedAt = 0;
  return () => {
    row.renew();
    if (now() - lookedAt < VERDICT_PASS_MS) return;
    lookedAt = now();
    row.withDb(db => finish(mainOwnedVerdictPorts(), db));
  };
}

// The cap is read on every dispatch pass, so a raised runner fleet or runnersOnly takes effect without a restart.
// Only a direct launch drains; importing this file to read its cap (as the test does) starts nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const row = dispatcherRow(process.cwd(), process.env[HANDOFF_DISPATCHER_OWNER_ENV]);
  let again;
  do {
    let drained;
    try { drained = await drainHandoffQueue({ startOf: exactStart, capacity: liveCapacity, sweep: sweepRepositoryInChild, admission: gateAdmission, onPass: dispatcherPass(row) }); }
    catch (error) {
      // The drain released its lock on the way out; exit now so a detached worker handle cannot keep a dead loop alive.
      reportDispatcherFailure(error);
      try { row.release(); } catch { /* a board that cannot be written lets the row lapse in 2 minutes */ }
      process.exit(1);
    }
    // The queue is empty: free the row so the next submit launches a dispatcher at once.
    try { row.release(); } catch { /* a board that cannot be written lets the row lapse in 2 minutes */ }
    again = lateTicketRetaken(drained, row);
  } while (again);
}
