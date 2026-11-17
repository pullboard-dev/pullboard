/** Machine-wide settings shared by every Pullboard checkout on this machine. */
import {
  chmodSync,
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import {
  setResourceCapacity,
  updateRunnerSettings,
} from '../../../resources/index.js';
import { validateRunner } from '../logic/settings.js';
import { PERSON_SET } from '../logic/settings.js';
import { parsePersonSet } from '../logic/settings.js';
import { loadMachineSettings } from '../logic/settings.js';
import { parseRunnerRate } from '../logic/runner-rates.js';
import { validateServe } from '../logic/settings.js';
import { validateBoardRemote } from '../logic/settings.js';
export { loadMachineSettings };
export { boardRemote } from '../logic/settings.js';
import { Refused } from '../../../kernel/index.js';
import { relayCanaryConfig } from '../logic/settings.js';
import {
  DEFAULT_RUNNER_WAIT_MS,
  validateRunnerWaitMs,
} from '../logic/settings.js';
import {
  carriedBrowserByLaunch,
  readGateQueueSettings,
  readMachineSettingsFile,
} from '../../../queue/index.js';
import { machineSettingsFile } from '../../../resources/index.js';
import { machineHome } from '../../../resources/index.js';

// The gate queue's settings live in the queue cell so the runner runtime can read them too.
export { machineSettingsFile };

/**
 * The gate pool's admission order from this machine's settings file. The front door for callers
 * above the config cell; the queue cell reads whichever file its caller names.
 *
 * @returns {{ reviewsFirst: boolean, currentReleaseFirst: boolean, agingMinutes: number }}
 */
export function gateQueueSettings() {
  return readGateQueueSettings(machineSettingsFile());
}

const DEFAULT_SHORT_SLOTS = 0;

/** Browser-free check admission is deliberately opt-in per machine. */
export function browserFreeChecksEnabled() {
  return loadMachineSettings().gate?.browserFreeChecks === true;
}

/** Runner-first admission is machine-wide and remains off unless explicitly enabled. */
export function gateRunnersFirstEnabled() {
  return loadMachineSettings().gate?.runnersFirst === true;
}

/** Run test processes at a lower scheduling priority than board writers only when this machine opted in [C7,#8509]. */
export function testNiceEnabled() {
  return loadMachineSettings().gate?.testNice === true;
}

/** Replay a changed move table in the submit gate only when this machine opted in [C7,#8073]. */
export function tableReplayEnabled() {
  return loadMachineSettings().gate?.tableReplay === true;
}

/** Start the submit proof while the cells step runs only when this machine opted in [C7,#9576]. */
export function overlapStaticProofEnabled() {
  return loadMachineSettings().gate?.overlapStaticProof === true;
}

/** Whether gate.componentTier is on (#9786): off by default; only an exact `true` turns it on. */
export function gateComponentTier() {
  return loadMachineSettings().gate?.componentTier === true;
}

/** Write gate hops through the fenced, compare-and-set hop row unless this machine turned it off [C7,#8269,#8327]. */
export function fencedHopEnabled() {
  return loadMachineSettings().gate?.fencedHop !== false;
}

/** Whether gate.recaptureHandoff is on (#8989): off by default; nothing reads it yet, and only an exact `true` turns it on. */
export function recaptureHandoffEnabled() {
  return loadMachineSettings().gate?.recaptureHandoff === true;
}

/** End an item's older open gate jobs on a new candidate or a landing only when this machine opted in [C7,#8816]. */
export function endStaleJobsEnabled() {
  return loadMachineSettings().gate?.endStaleJobs === true;
}

/** Offer a gate job once more after an infrastructure end only when this machine opted in [C7,#9633]. */
export function reofferInfraEndEnabled() {
  return loadMachineSettings().gate?.reofferInfraEnd === true;
}

/** Settle a sharded item gate left unknown on a missing main receipt when that receipt records, only when this machine opted in [C7,#9057]. */
export function settleOnMainReceiptEnabled() {
  return loadMachineSettings().gate?.settleOnMainReceipt === true;
}

/** Name the file:line a static check reported in a pulled gate's red fact only when this machine opted in; off, the fact is unchanged [C7,#9083]. */
export function redFactLocationEnabled() {
  return loadMachineSettings().gate?.redFactLocation === true;
}

/** Fail the registry check on an unregistered test only when this machine opted in; off, it reports [C7,#8374]. */
export function registryStrictEnabled() {
  return loadMachineSettings().tests?.registryStrict === true;
}

/** Whether verdict freshness compares the submit's own hunks: off by default; only an exact `true` turns it on [C7,#9438]. */
export function hunkFreshnessEnabled() {
  return loadMachineSettings().verify?.hunkFreshness === true;
}

/** Whether the static check refuses a change that adds an unregistered test: off by default; only an exact `true` turns it on [C7,#9402]. */
export function requireRegisteredEnabled() {
  return loadMachineSettings().tests?.requireRegistered === true;
}

/** Whether the test-input rule reports tests that read repo files outside src without an input header: off by default; only an exact `true` turns it on [C7,#9799]. */
export function requireDeclaredInputsEnabled() {
  return loadMachineSettings().tests?.requireDeclaredInputs === true;
}

/** Whether the static check refuses an added journey that names no golden user path: off by default; only an exact `true` turns it on [C7,#9403]. */
export function requireJourneyPathEnabled() {
  return loadMachineSettings().tests?.requireJourneyPath === true;
}

/** Whether the static check refuses new direct clock reads outside the kernel: off by default; only an exact `true` turns it on [C7,#9447]. */
export function adapterLintClockEnabled() {
  return loadMachineSettings().gate?.adapterLintClock === true;
}

/** Whether the static check refuses new direct node:fs imports outside the kernel: off by default; only an exact `true` turns it on [C7,#9449]. */
export function adapterLintFsEnabled() {
  return loadMachineSettings().gate?.adapterLintFs === true;
}

/** Whether the static check refuses a statement shape copied into 3 or more files: off by default; only an exact `true` turns it on [C7,#9521]. */
export function idiomSpreadEnabled() {
  return loadMachineSettings().gate?.idiomSpread === true;
}

/** Record each move table shadow compare on the board only when this machine opted in [C7,#8376]. */
export function movesShadowEnabled() {
  return loadMachineSettings().moves?.shadow === true;
}

/** Let a move writer follow its move table only when this machine opted in for that table [C7,#8383]. */
export function movesLiveEnabled(table) {
  return loadMachineSettings().moves?.live?.[table] === true;
}

/** Write each pulled census's per-file times back for the next census plan only when this machine opted in; off, the census writes none [C7]. */
export function censusRecordFileTimesEnabled() {
  return loadMachineSettings().census?.recordFileTimes === true;
}

/** Rerun each non-green census file once, alone, before reporting it red, only when this machine opted in; off, rows are the first run's [C7,#9138]. */
export function censusRerunNonGreenEnabled() {
  return loadMachineSettings().census?.rerunNonGreen === true;
}

/** Rerun a non-green census file the moment its job settles, under the 3-minute file kill, only when this machine opted in; off, reruns wait for the whole pass [C7,#9283]. */
export function censusRerunOnSettleEnabled() {
  return loadMachineSettings().census?.rerunOnSettle === true;
}

/** Cut pulled census jobs by measured time, heaviest first, only when this machine opted in; off, they are cut by file count [C7]. */
export function censusBalanceByTimeEnabled() {
  return loadMachineSettings().census?.balanceByTime === true;
}

/** Whether census.selfTune is on: off by default; only an exact `true` lets a pulled census size its jobs from the previous census's shard times [C7,U151]. */
export function censusSelfTuneEnabled() {
  return loadMachineSettings().census?.selfTune === true;
}

/** Minutes of measured time one pulled census job may hold; null (the default) keeps jobs cut by file count [C7]. */
export function censusJobMinutes() {
  const minutes = loadMachineSettings().census?.jobMinutes;
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

/** Seconds over which a file recorded in an earlier census plans as a census job to itself; null (the default) plans as before [C7,#9499]. */
export function censusSoloFileSeconds() {
  const secs = loadMachineSettings().census?.soloFileSeconds;
  return Number.isSafeInteger(secs) && secs >= 1 ? secs : null;
}

/** Census test jobs one runner may hold at once; null (the default) leaves census jobs uncapped beyond runner slots [C7,#9136]. */
export function censusJobsPerRunner() {
  const jobs = loadMachineSettings().census?.jobsPerRunner;
  return Number.isSafeInteger(jobs) && jobs >= 1 ? jobs : null;
}

/** Census test jobs a runner holding no other kind of job may hold at once, above census.jobsPerRunner; null (the default) keeps the one cap for every runner [C7,#9500]. */
export function censusJobsPerRunnerQuiet() {
  const jobs = loadMachineSettings().census?.jobsPerRunnerQuiet;
  return Number.isSafeInteger(jobs) && jobs >= 1 ? jobs : null;
}

/** Whether jobs.avoidRunners is on: off by default; only an exact `true` makes claimJob skip the runners a job's offer names [C7,#9273]. */
export function jobsAvoidRunnersEnabled() {
  return loadMachineSettings().jobs?.avoidRunners === true;
}

/** Whether push.recordTiming is on: off by default; only an exact `true` makes a finished pre-push gate record its wall clock and per-shard times on the board [C7,U151,#9371]. */
export function pushRecordTimingEnabled() {
  return loadMachineSettings().push?.recordTiming === true;
}

/** Whether push.rerunFailedShardOnce is on: off by default; only an exact `true` lets the pre-push gate re-offer a failed shard once [C7,#9274]. */
export function pushRerunFailedShardOnceEnabled() {
  return loadMachineSettings().push?.rerunFailedShardOnce === true;
}

/** Run the full suite after each landed train batch only when this machine opted in. */
export function postLandSuiteEnabled() {
  return loadMachineSettings().gate?.postLandSuite === true;
}

/** Capture one test operation's opt-in and cutoff; retries and later phases share this exact policy. */
export function gateRunnerAdmission() {
  const settings = loadMachineSettings();
  if (settings.gate?.runnersOnly !== true) return {};
  const runnerWaitMs = settings.gate?.runnerWaitMs ?? DEFAULT_RUNNER_WAIT_MS;
  return { runnerOnly: true, remote: true, runnerWaitMs, runnerDeadlineAt: Date.now() + runnerWaitMs };
}

/** Set only the opt-in test execution policy, preserving unrelated machine settings. */
export function setGateRunnersOnly(enabled) {
  if (typeof enabled !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnersOnly must be true or false; run pullboard settings gate.runnersOnly on|off');
  const current = loadMachineSettings();
  let next;
  setResourceCapacity({ name: 'gate', capacity: current.gateSlots, scope: 'machine', allowZero: current.gateSlots === 0, persist: () => {
    const latest = loadMachineSettings();
    next = { ...latest, gate: { ...latest.gate, runnersOnly: enabled } };
    writeMachineSettings(next);
  } });
  return next;
}

/**
 * The most seconds-worth of non-test time one runner trip may take before gate receipts report it, in milliseconds.
 * Why 10 s: the warm trip measured on 15 Nov costs about 7 s, so the default is that plus about 40% margin for load.
 */
export function gateTripOverheadBudgetMs() {
  try { return loadMachineSettings().gate?.tripOverheadBudgetMs ?? 10_000; } catch { return 10_000; }
}

/** Capture the runner wait deadline for a new run; later requeues retain that deadline. */
export function gateRunnerWaitMs() {
  return loadMachineSettings().gate?.runnerWaitMs ?? DEFAULT_RUNNER_WAIT_MS;
}

/** Parse the person's budget, such as 40/day or 200/week: spend over a declared window, one unit being a seat-hour of an unpriced model. */
export function parseWorkerBudget(text) {
  const match = /^(\d+(?:\.\d+)?)\/(day|week)$/u.exec(String(text));
  const spend = match ? Number(match[1]) : NaN;
  if (!match || !Number.isFinite(spend) || spend < 0) {
    throw new Refused('BAD_MACHINE_SETTINGS', 'workers.budget is spend per day or week, such as 40/day or 200/week; 0/day turns it off');
  }
  return { spend, window: match[2] };
}

/** The spend pullboard run --scale may use per day or week on this machine, or null when unset (off); a budget stored as seatHours reads as the same spend. */
export function workerBudget() {
  const stored = loadMachineSettings().workers?.budget;
  return stored ? { spend: stored.spend ?? stored.seatHours, window: stored.window } : null;
}

/** Set the spend budget; a lower budget stops only idle workers, so it never interrupts a claim or a review. */
export function setWorkerBudget(budget) {
  const current = loadMachineSettings();
  const next = { ...current, workers: { ...current.workers, budget: { spend: budget.spend, window: budget.window } } };
  writeMachineSettings(next);
  return next;
}


/**
 * Set board.url, board.token or board.commits; the value off removes it, so seats use the local board again [P7].
 * @param {'url' | 'token' | 'commits'} key
 * @param {string} value
 */
export function setBoardRemote(key, value) {
  const current = loadMachineSettings();
  const { [key]: _old, ...rest } = current.board ?? {};
  const board = value === 'off' ? rest : { ...rest, [key]: value };
  validateBoardRemote(board, 'the command line');
  const { board: _board, ...others } = current;
  const next = Object.keys(board).length ? { ...others, board } : others;
  writeMachineSettings(next);
  return next;
}

/** Set the runner deadline for new work without changing any admitted or queued run. */
export function setGateRunnerWaitMs(milliseconds) {
  validateRunnerWaitMs(milliseconds);
  const current = loadMachineSettings();
  const next = { ...current, gate: { ...current.gate, runnerWaitMs: milliseconds } };
  writeMachineSettings(next);
  return next;
}

/**
 * Store one runner's rate card in machine settings, refusing a card with a missing or invalid field.
 * Why: a later cost figure is only as honest as its inputs, so only a whole, valid card is stored.
 *
 * @param {string} host - The runner host the card belongs to.
 * @param {unknown} card - { price, months, watts, kwhPrice }.
 * @returns {object} The settings now stored.
 */
export function setRunnerRate(host, card) {
  const parsed = parseRunnerRate(card, host);
  const current = loadMachineSettings();
  const next = { ...current, runnerRates: { ...current.runnerRates, [host]: parsed } };
  writeMachineSettings(next);
  return next;
}

/**
 * Classifying a test file as browser-bound only when it reaches a real Chrome launch is opt-in per
 * machine; off, any path to the Chrome fixture or an unfollowed process starter takes a browser slot.
 */
export function browserByLaunchEnabled() {
  return carriedBrowserByLaunch() ?? loadMachineSettings().gate?.browserByLaunch === true;
}

/**
 * Whether a red gate is compared with main: `on-red` (default) or `off` [C7,#5565]. Anything but an exact `off` compares,
 * so a damaged value keeps the safe behaviour; `off` makes a red gate plain red.
 */
export function mainComparisonMode() {
  return loadMachineSettings().gate?.mainComparison === 'off' ? 'off' : 'on-red';
}

/**
 * Whether submit refuses at once when the frozen check names a test file the submitted commit lacks (#3095): off by
 * default, so a submit queues its gate as before; only an exact `true` turns the refusal on.
 */
export function refuseMissingCheckFile() {
  return loadMachineSettings().gate?.refuseMissingCheckFile === true;
}

/**
 * Whether `pullboard worktree` refuses a seat folder under the OS temporary directory (#8513): off by default, so
 * worktrees are made where they always were; only an exact `true` turns the refusal on.
 */
export function refuseTempWorktree() {
  return loadMachineSettings().gate?.refuseTempWorktree === true;
}

/** Whether claim.keepWhileRunning is on: off by default; only an exact `true` keeps a claim whose holder has a test run, test or gate job in flight from being released as idle or stalled [C7,#9498]. */
export function claimKeepWhileRunning() {
  return loadMachineSettings().claim?.keepWhileRunning === true;
}

/** Whether claim.refuseOffMainHead is on: off by default; only an exact `true` makes claim refuse a folder whose HEAD is not on main [C7,#9104]. */
export function refuseOffMainHead() {
  return loadMachineSettings().claim?.refuseOffMainHead === true;
}

/** Whether freezing a bar refuses an empty criterion (#9443): off by default; only an exact `true` turns it on. */
export function refuseEmptyBar() {
  return loadMachineSettings().freeze?.refuseEmptyBar === true;
}

/** Whether a landed reject's follow-up keeps its parent's check (#9637): off by default; only an exact `true` turns it on. */
export function rejectKeepsCheck() {
  return loadMachineSettings().verify?.rejectKeepsCheck === true;
}

/** Whether a joining seat's family label is canonicalised (#9681): off by default; only an exact `true` turns it on. */
export function reviewCanonicalFamilies() {
  return loadMachineSettings().review?.canonicalFamilies === true;
}

/** Whether a coordinator move records its own session usage (#9685): off by default; only an exact `true` turns it on. */
export function statsRecordCoordinatorUsage() {
  return loadMachineSettings().stats?.recordCoordinatorUsage === true;
}

/** Whether a starved green review shouts the coordinator (#9682): off by default; only an exact `true` turns it on. */
export function reviewStarveShout() {
  return loadMachineSettings().review?.starveShout === true;
}

/** Whether a review release must name why it was dropped (#8920): off by default; only an exact `true` turns it on. */
export function reviewReleaseReasonsRequired() {
  return loadMachineSettings().review?.releaseReasons === true;
}

/** Whether test.statusOutcomes is on (#9085): off by default; only an exact `true` turns it on. */
export function testStatusOutcomesEnabled() {
  const group = loadMachineSettings().test;
  return group?.statusOutcomes === true;
}

/** Whether spec.cascadeReject is on (#9341): off by default; only an exact `true` turns it on. */
export function cascadeRejectEnabled() {
  return loadMachineSettings().spec?.cascadeReject === true;
}

/** Whether engine.nameBehindDevice is on (#9418): off by default; a caller reads it and passes it to prepareEngineMove, since a move never reads a setting. */
export function nameBehindDeviceEnabled() {
  return loadMachineSettings().engine?.nameBehindDevice === true;
}

/** Whether items.typedFields is on (#9350): off by default; only an exact `true` turns it on. */
export function typedFieldsEnabled() {
  return loadMachineSettings().items?.typedFields === true;
}

/** Whether health.derivedState is on (#8974): off by default; nothing reads it yet, and only an exact `true` turns it on. */
export function derivedStateEnabled() {
  return loadMachineSettings().health?.derivedState === true;
}

/** Whether landing.reofferTrunkBusy is on (#9102): off by default; only an exact `true` turns it on. */
export function reofferTrunkBusyEnabled() {
  return loadMachineSettings().landing?.reofferTrunkBusy === true;
}

/** Whether landing.adaptiveBatch is on (#9017): off by default; only an exact `true` turns it on. */
export function adaptiveBatchEnabled() {
  return loadMachineSettings().landing?.adaptiveBatch === true;
}

/** Whether the wait audit records who held a slow board write (#9118): off by default; only an exact `true` turns it on. */
export function recordWriteHolderEnabled() {
  return loadMachineSettings().sentinels?.recordWriteHolder === true;
}

/** Whether landing.squash is on (#9217): off by default; only an exact `true` turns it on. */
export function landingSquashEnabled() {
  return loadMachineSettings().landing?.squash === true;
}

/** Whether status.showUsefulBuilders is on: off by default; only an exact `true` makes status print the max useful builders line [C7,#8544]. */
export function statusShowUsefulBuilders() {
  return loadMachineSettings().status?.showUsefulBuilders === true;
}

/** Whether spec.commitOnApply is on (#9346): off by default; only an exact `true` turns it on. */
export function commitOnApplyEnabled() {
  return loadMachineSettings().spec?.commitOnApply === true;
}

/** Whether landing.strictFullSuite is on (#9323): off by default; only an exact `true` turns it on. */
export function strictFullSuiteEnabled() {
  return loadMachineSettings().landing?.strictFullSuite === true;
}

/** Whether the sentinel expires lapsed claims every minute (#8923): off by default; only an exact `true` turns it on. */
export function lapsedSweepEnabled() {
  return loadMachineSettings().health?.lapsedSweep === true;
}

/** Whether docs.regenerateOnCommit is on (#9664): off by default; only an exact `true` turns it on. */
export function docsRegenerateOnCommit() {
  return loadMachineSettings().docs?.regenerateOnCommit === true;
}

/** Whether add.warnUnnamedTest is on (#9303): off by default; only an exact `true` turns it on. */
export function addWarnUnnamedTest() {
  return loadMachineSettings().add?.warnUnnamedTest === true;
}

/** Whether an untouched release counts toward the route-up rule (#9759): off by default; only an exact `true` turns it on. */
export function releaseRerouteUntouched() {
  return loadMachineSettings().release?.rerouteUntouched === true;
}

/** Whether a settled hold lifts when main moves (#9699): off by default; only an exact `true` turns it on. */
export function holdsLiftSettled() {
  return loadMachineSettings().holds?.liftSettled === true;
}

/**
 * Whether an item hold must name an owner and records a deadline (#8539): off by default, so holds are unchanged; only an
 * exact `true` turns it on.
 */
export function holdsRequireOwner() {
  return loadMachineSettings().holds?.requireOwner === true;
}

/**
 * Whether next --take restores the pinned head of a returned item into the new item folder (#9689): off by default, so
 * next --take claims exactly as before; only an exact `true` turns it on.
 */
export function nextAdoptPreserved() {
  return loadMachineSettings().next?.adoptPreserved === true;
}

/**
 * Whether next lists the shouts and rulings that name the item it hands out (#8787): off by default, so next prints exactly
 * what it did before; only an exact `true` turns it on.
 */
export function nextItemNotices() {
  return loadMachineSettings().next?.itemNotices === true;
}

/**
 * Whether an idle next lists the waiting items and what each waits on (#2958): off by default, so an idle answer prints
 * exactly what it did before; only an exact `true` turns it on.
 */
export function nextIdleBlockers() {
  return loadMachineSettings().next?.idleBlockers === true;
}

/**
 * The builder cap behind next.capBuilders (#8545): the most seats that may hold a claim at once before next offers a review
 * instead of a build; 0 (default) is off, and anything but a positive whole number is off, so a damaged value never starves builds.
 */
export function nextCapBuilders() {
  const cap = loadMachineSettings().next?.capBuilders;
  return Number.isInteger(cap) && cap > 0 ? cap : 0;
}

/**
 * Whether next hands no new claim while the machine load is above machine.loadCeiling (#9703): off by default, so next hands
 * claims as before; only an exact `true` turns it on.
 */
export function nextHoldAboveLoad() {
  return loadMachineSettings().next?.holdAboveLoad === true;
}

/**
 * Whether next passes over an item whose readiness command exits non-zero (#8793): off by default, so next offers items as
 * before; only an exact `true` turns it on.
 */
export function nextReadinessCheck() {
  return loadMachineSettings().next?.readinessCheck === true;
}

/**
 * Whether next keeps each readiness result for the main commit it ran on (#8794): off by default, so next reruns the
 * command on every call; only an exact `true` turns it on.
 */
export function nextReadinessCache() {
  return loadMachineSettings().next?.readinessCache === true;
}

/**
 * Where a queued submit's authorization source checks run when a runner is registered: `runner` (default) puts them in
 * the gate's one runner analysis job beside doctrine, cells, static and selection; `local` keeps them on this machine as
 * before #5674. Anything but an exact `local` is the default, so a damaged value never moves work back here [C7].
 */
export function submitAuthorizationMode() {
  return loadMachineSettings().gate?.submitAuthorization === 'local' ? 'local' : 'runner';
}

/**
 * How a runner job is watched: always `pull`, which offers each job as a row a runner takes and waits on a shared status
 * mirror in the caller; the controller value is gone from the settings schema [C7,P7,#5465]. Why pull: a fresh board's
 * gate runs on the zero-setup loopback runner, so no command holds this machine while it runs.
 */
export function runnerDispatchMode() {
  return 'pull';
}

/**
 * Whether this machine may run its own local runner: on unless gate.localRunner is exactly false. Why on: a solo
 * user's machine is board host and runner at once, so pulled gates and landings need no setup [P7].
 */
export function localRunnerEnabled() {
  return loadMachineSettings().gate?.localRunner !== false;
}

/**
 * The load per core below which the local runner takes a job: gate.localLoadShare, default 1.0. Why: with no runners the
 * machine runs its own gates, and taking one at any load thrashed a busy Mac; a job waits in the queue instead [P7].
 */
export function localLoadShare() {
  const share = loadMachineSettings().gate?.localLoadShare;
  return Number.isFinite(share) && share > 0 ? share : 1;
}

/**
 * How many local `pullboard gate --static` runs this machine admits at once: gate.staticSlots, default 2. Why: each run
 * is about a minute of full-CPU tree work, and 14 at once drove a Mac to load 104; a waiting run queues instead [C7,#8501].
 */
export function staticCheckSlots() {
  const slots = loadMachineSettings().gate?.staticSlots;
  return Number.isSafeInteger(slots) && slots > 0 ? slots : 2;
}

/**
 * Whether a green local `pullboard gate --static` is kept for its exact clean tree and main: gate.staticMemo, default off.
 * Why: a refused submit is usually resubmitted on the same tree, and its static rerun repeated a green minute of full CPU [C7].
 */
export function staticMemoOn() {
  return loadMachineSettings().gate?.staticMemo === true;
}

/**
 * Whether the always-run static registry refuses a changed test that adds an unclassified file-board open: gate.boardOpensCheck, default off.
 * Why: the open guard otherwise runs only when its own test is selected, so a new unannotated open could land unseen [C7].
 */
export function boardOpensCheckOn() {
  return loadMachineSettings().gate?.boardOpensCheck === true;
}

/** Whether `pullboard serve` also answers runner pulls at /pull/ (#8765): off by default; only an exact `true` turns it on. */
export function servePullRoute() {
  return loadMachineSettings().serve?.pullRoute === true;
}

/**
 * Where `pullboard serve` listens, from the machine's `serve` setting: loopback and a free port unless set; a flag
 * given for either overrides the setting and is checked by the same rule [P7,O5,O6].
 * @param {{ address?: string, port?: number }} [flags]
 * @returns {{ address: string, port: number }}
 */
export function serveListen(flags = {}) {
  const given = Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== undefined));
  validateServe(given, 'the command line');
  const serve = loadMachineSettings().serve;
  return { address: given.address ?? serve?.address ?? '127.0.0.1', port: given.port ?? serve?.port ?? 0 };
}

/**
 * Whether init and resume keep a view running in the background [H5,N26]. Unlike the gate's
 * settings this is on by default: pullboard.dev can only open a computer's boards while its view
 * runs, and a newcomer should never need a command for that. Only `"view": { "background": false }`
 * turns it off.
 */
export function viewBackgroundEnabled() {
  return loadMachineSettings().view?.background !== false;
}

/** The automatic health observer is on unless the machine or this board explicitly turns it off. */
export function healthSentinelEnabled(config = {}) {
  if (config.health?.sentinel !== undefined && typeof config.health.sentinel !== 'boolean') {
    throw new Refused('BAD_CONFIG', 'health.sentinel in pullboard.json must be true or false');
  }
  return config.health?.sentinel !== false && loadMachineSettings().health?.sentinel !== false;
}

/**
 * The free-memory floor, in megabytes, below which the machine gate pool holds its queue, or null
 * when the hold is off. Gate and queue behavior is off by default, the person's rule, so an absent
 * floor keeps today's admission by slots alone.
 */
export function memoryFloorMB() {
  return loadMachineSettings().gate?.memoryFloorMB ?? null;
}

/**
 * Whether init asks the person once to share this computer's boards with their phone [H5,H17].
 * On unless the machine settings set relay.offerAtInit to false: the person asked for sharing to
 * be one Enter for new people, and a person who never wants the question turns it off here.
 */
export function relayOfferEnabled() {
  return loadMachineSettings().relay?.offerAtInit !== false;
}

/** Atomically replace machine settings without exposing a partial JSON file. */
function writeMachineSettings(settings) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Set one plain-valued machine setting from what a person typed, or clear it with `off`, keeping every other setting.
 * A value the loader refuses is rolled back, so a typo never leaves settings.json unreadable [O5,O6,N26].
 */
export function setPersonSetting(key, text) {
  const value = parsePersonSet(key, text);
  if (PERSON_SET[key] === 'folder' && value !== undefined && !statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Refused('BAD_MACHINE_SETTINGS', `scratch must be an absolute folder that exists, or off; run pullboard settings scratch <folder>|off`);
  }
  const settings = structuredClone(loadMachineSettings());
  const names = key.split('.');
  const parents = names.slice(0, -1).reduce((node, name) => (node[name] = node[name] && typeof node[name] === 'object' ? node[name] : {}), settings);
  if (value === undefined) delete parents[names.at(-1)]; else parents[names.at(-1)] = value;
  const file = machineSettingsFile();
  const before = existsSync(file) ? readFileSync(file) : null;
  writeMachineSettings(settings);
  try { loadMachineSettings(); } catch (error) {
    if (before) writeFileSync(file, before, { mode: 0o600 }); else rmSync(file, { force: true });
    throw error;
  }
  return settings;
}

/** Persist an explicitly configured canary without changing any board's credentials or project policy. */
export function setRelayCanary(value) {
  const canary = relayCanaryConfig(value);
  const settings = loadMachineSettings();
  const next = { ...settings, relay: { ...settings.relay, canary } };
  writeMachineSettings(next);
  return canary;
}

/** Opt this machine into one board's landing pool without cancelling any admitted work. */
export function setLandingPool(board, enabled) {
  if (!/^[a-f0-9]{32}$/u.test(board) || typeof enabled !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', 'a landing pool needs this board identifier and on or off');
  const settings = loadMachineSettings();
  const pools = new Set(settings.landing?.pools ?? []);
  if (enabled) pools.add(board); else pools.delete(board);
  const next = { ...settings, landing: { ...settings.landing, pools: [...pools].sort() } };
  writeMachineSettings(next);
  return next;
}

/** Raise machine gate capacity immediately; decreases require an empty durable queue. */
export function setGateSlots(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Refused('BAD_GATE_SLOTS', 'gateSlots must be a whole number, 0 or more; 0 requires a registered runner');
  let next;
  setResourceCapacity({ name: 'gate', capacity, scope: 'machine', allowZero: capacity === 0, persist: () => {
    const current = loadMachineSettings();
    if (capacity === 0 && !current.runners?.length) throw new Refused('BAD_GATE_SLOTS', 'gateSlots 0 requires a registered runner; run pullboard runner add <ssh-host> --slots <n> --browser <n>');
    if (capacity < current.browserSlots) throw new Refused('BAD_GATE_SLOTS', `gateSlots cannot be lower than browserSlots (${current.browserSlots}); first run pullboard settings browserSlots <n>`);
    next = { ...current, gateSlots: capacity };
    writeMachineSettings(next);
  } });
  return next;
}

/**
 * Short gate slots admit runs that name their test files while every ordinary slot is busy.
 * The default 0 keeps them off, so the pool behaves exactly as it did before the setting existed.
 */
export function gateShortSlots() {
  return loadMachineSettings().gate?.shortSlots ?? DEFAULT_SHORT_SLOTS;
}

/** Set the short slot count only while the gate pool is idle, like gateSlots, so no holder changes class mid-run. */
export function setGateShortSlots(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Refused('BAD_SHORT_SLOTS', 'gate.shortSlots must be a whole number, 0 or more; run pullboard settings gate.shortSlots <n>');
  let next;
  try {
    setResourceCapacity({ name: 'gate', capacity: loadMachineSettings().gateSlots, scope: 'machine', persist: () => {
      const current = loadMachineSettings();
      next = { ...current, gate: { ...current.gate, shortSlots: count } };
      writeMachineSettings(next);
    } });
  } catch (error) {
    if (error?.code !== 'RESOURCE_BUSY') throw error;
    throw new Refused('RESOURCE_BUSY', `the gate pool is in use; wait for it to become idle, then retry pullboard settings gate.shortSlots ${count}`);
  }
  return next;
}

/** Raise machine browser capacity immediately; decreases require an empty browser queue. */
export function setBrowserSlots(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Refused('BAD_BROWSER_SLOTS', 'browserSlots must be a whole number, 0 or more; 0 requires a registered runner');
  let next;
  setResourceCapacity({ name: 'browser', capacity, scope: 'machine', allowZero: capacity === 0, persist: () => {
    const current = loadMachineSettings();
    if (capacity === 0 && !current.runners?.length) throw new Refused('BAD_BROWSER_SLOTS', 'browserSlots 0 requires a registered runner; run pullboard runner add <ssh-host> --slots <n> --browser <n>');
    if (capacity > current.gateSlots) throw new Refused('BAD_BROWSER_SLOTS', `browserSlots cannot exceed gateSlots (${current.gateSlots}); run pullboard settings gateSlots <n> first`);
    next = { ...current, browserSlots: capacity };
    writeMachineSettings(next);
  } });
  return next;
}

/** Set the machine-wide runner-first gate policy while preserving other gate settings. */
export function setGateRunnersFirst(enabled) {
  if (typeof enabled !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnersFirst must be true or false; run pullboard settings gate.runnersFirst on|off');
  let next;
  const current = loadMachineSettings();
  setResourceCapacity({ name: 'gate', capacity: current.gateSlots, scope: 'machine', allowZero: current.gateSlots === 0, persist: () => {
    const latest = loadMachineSettings();
    next = { ...latest, gate: { ...latest.gate, runnersFirst: enabled } };
    writeMachineSettings(next);
  } });
  return next;
}

/** Clause inspection of numbered criteria is machine-wide and off unless enabled. */
export function clauseInspectionEnabled() {
  return loadMachineSettings().inspection?.clauses === true;
}

/** Turn clause inspection on or off, preserving other machine settings. */
export function setClauseInspection(enabled) {
  if (typeof enabled !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', 'inspection.clauses must be true or false; run pullboard settings inspection.clauses on|off');
  const latest = loadMachineSettings();
  const next = { ...latest, inspection: { ...latest.inspection, clauses: enabled } };
  writeMachineSettings(next);
  return next;
}

/** Opt in to runner slots computed from each runner's measured cores and memory, preserving other gate settings. */
export function setGateMeasuredSlots(enabled) {
  if (typeof enabled !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', 'gate.measuredSlots must be true or false; run pullboard settings gate.measuredSlots on|off');
  let next;
  const current = loadMachineSettings();
  setResourceCapacity({ name: 'gate', capacity: current.gateSlots, scope: 'machine', allowZero: current.gateSlots === 0, persist: () => {
    const latest = loadMachineSettings();
    next = { ...latest, gate: { ...latest.gate, measuredSlots: enabled } };
    writeMachineSettings(next);
  } });
  return next;
}

/** Set the opt-in measured CPU dispatch policy without changing registered capacity. */
export function setGateLoadDispatch(key, value) {
  if (key === 'loadAwareDispatch' ? typeof value !== 'boolean' : key !== 'runnerBusyCeiling' || !Number.isFinite(value) || value < 1 || value > 100) throw new Refused('BAD_MACHINE_SETTINGS', 'set gate.loadAwareDispatch on|off or gate.runnerBusyCeiling 1..100');
  let next;
  const current = loadMachineSettings();
  setResourceCapacity({ name: 'gate', capacity: current.gateSlots, scope: 'machine', allowZero: current.gateSlots === 0, persist: () => {
    const latest = loadMachineSettings();
    next = { ...latest, gate: { ...latest.gate, [key]: value } };
    writeMachineSettings(next);
  } });
  return next;
}

/** Register plain SSH capacity without storing credentials, and serialize updates with active dispatches. */
export function addRunner(value) {
  const runner = validateRunner(value);
  return updateRunnerSettings(runner.host, () => {
    const current = loadMachineSettings();
    const runners = [...(current.runners ?? [])];
    const index = runners.findIndex(entry => entry.host === runner.host);
    if (index < 0) runners.push(runner);
    else runners[index] = runner;
    writeMachineSettings({ ...current, runners });
    return runner;
  }, { allowWhenHeld: () => {
    // Only an increase applies to a busy runner; a decrease waits for its active runs.
    const prior = (loadMachineSettings().runners ?? []).find(entry => entry.host === runner.host);
    return Boolean(prior) && runner.slots >= prior.slots && runner.browser >= prior.browser;
  } });
}

/** Store measured facts on the latest registered host without changing fixed policy or clearing recovery fences. */
export function recordRunnerMeasurement(host, observation) {
  return updateRunnerSettings(host, ({ held = 0 } = {}) => {
    const current = loadMachineSettings();
    const index = (current.runners ?? []).findIndex(runner => runner.host === host);
    if (index < 0) throw new Refused('RUNNER_NOT_REGISTERED', `runner ${host} is no longer registered; run pullboard runner list`);
    const prior = current.runners[index];
    // A busy runner records only its live load: new cores could shrink its slots under admitted jobs.
    const size = held && Number.isSafeInteger(prior.cores) ? {} : { cores: observation.cores, memoryMB: observation.memoryMB, measuredAt: observation.measuredAt };
    const runner = validateRunner({ ...prior, ...size,
      ...(observation.cpuLoad === undefined ? {} : { cpuLoad: observation.cpuLoad }),
      ...(observation.gui === undefined ? {} : { gui: observation.gui }) });
    const runners = [...current.runners]; runners[index] = runner;
    writeMachineSettings({ ...current, runners });
    return runner;
  }, { observation: true });
}

/**
 * Take a registered runner out of rotation (`drain`) or back in: dispatch and pull claims give it no new job, its running
 * jobs keep their leases and finish. Why: a runner jammed overnight and nothing could rest it while a fix rolled out.
 */
export function setRunnerDrain(host, drain) {
  return updateRunnerSettings(host, () => {
    const current = loadMachineSettings();
    const index = (current.runners ?? []).findIndex(runner => runner.host === host);
    if (index < 0) throw new Refused('RUNNER_NOT_REGISTERED', `runner ${host} is not registered`, 'run pullboard runner list');
    const { drain: _drained, ...rest } = current.runners[index];
    const runner = validateRunner(drain ? { ...rest, drain: true } : rest);
    const runners = [...current.runners]; runners[index] = runner;
    writeMachineSettings({ ...current, runners });
    return runner;
  }, { observation: true });
}

/**
 * The share of each runner's slots every job class keeps (gate.jobReserve), or null: unset keeps today's claim order,
 * set makes a claim take the highest class first while each class keeps its reserve [C7].
 */
export function jobReserve() {
  return loadMachineSettings().gate?.jobReserve ?? null;
}

/** The hosts taken out of rotation with `pullboard runner drain`: a pull runner serving under one of these ids is given no job. */
export function drainedRunnerHosts() {
  return (loadMachineSettings().runners ?? []).filter(runner => runner.drain === true).map(runner => runner.host);
}

/** Stop dispatching to a runner immediately; admitted jobs keep their leases until they finish. */
export function removeRunner(host) {
  return updateRunnerSettings(host, () => {
    const current = readMachineSettingsFile(machineSettingsFile()) ?? {};
    const currentSettings = loadMachineSettings();
    const runners = currentSettings.runners ?? [];
    const index = runners.findIndex(runner => runner.host === host);
    if (index < 0) {
      const registered = runners.map(runner => runner.host);
      throw new Refused('RUNNER_NOT_REGISTERED', `runner ${host} is not registered`,
        registered.length ? `registered runners: ${registered.join(', ')}` : 'run pullboard runner add <ssh-host> --slots <n> --browser <n> first');
    }
    if (runners.length === 1 && (currentSettings.gateSlots === 0 || currentSettings.browserSlots === 0)) {
      throw new Refused('RUNNER_REQUIRED_FOR_ZERO_CAPACITY', 'this is the last registered runner and a local gate capacity is 0; restore positive gateSlots and browserSlots before removing it');
    }
    const [runner] = runners.splice(index, 1);
    writeMachineSettings({ ...current, runners });
    return runner;
  }, { drain: true });
}

/** Where the machine keeps its board key, the secret runners send when `pullboard serve` listens off loopback [P7,O5]. */
export function boardKeyFile() {
  return join(machineHome(), 'board.key');
}

/**
 * Read this machine's board key, creating it on first use.
 * Why a file and not a fresh secret per start: an installed runner keeps the board URL and key across board restarts.
 *
 * @returns {string}
 */
export function boardKey() {
  const file = boardKeyFile();
  let key;
  try { key = readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(machineHome(), { recursive: true, mode: 0o700 });
    try { writeFileSync(file, `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (raced) { if (raced.code !== 'EEXIST') throw raced; }
    key = readFileSync(file, 'utf8').trim();
  }
  chmodSync(file, 0o600);
  if (!/^[A-Za-z0-9_-]{24,128}$/u.test(key)) throw new Refused('BAD_BOARD_KEY', `${file} does not hold a board key; delete it and run pullboard serve again to make a new one`);
  return key;
}

/** Whether board.archiveEvents is on (#9334): off by default; only an exact `true` turns it on. */
export function archiveEventsEnabled() {
  return loadMachineSettings().board?.archiveEvents === true;
}

/** Whether board.hotState is on (#9338): off by default; only an exact `true` turns it on. */
export function hotStateEnabled() {
  return loadMachineSettings().board?.hotState === true;
}

/** Whether api.codeStampCache is on (#9679): off by default; only an exact `true` turns it on. */
export function codeStampCacheEnabled() {
  return loadMachineSettings().api?.codeStampCache === true;
}

/** Whether landing.reuseContractResults is on (#9301): off by default; only an exact `true` turns it on. */
export function reuseContractResultsEnabled() {
  return loadMachineSettings().landing?.reuseContractResults === true;
}

/** Whether landing.stallStop is on (#8749): off by default; only an exact `true` turns it on. */
export function stallStopEnabled() {
  return loadMachineSettings().landing?.stallStop === true;
}

/** Whether landing.parallelGates is on (#9747): off by default; only an exact `true` turns it on. */
export function parallelGatesEnabled() {
  return loadMachineSettings().landing?.parallelGates === true;
}

/** Whether landing.asyncFetch is on (#9516): off by default; only an exact `true` turns it on. */
export function asyncFetchEnabled() {
  return loadMachineSettings().landing?.asyncFetch === true;
}

/** Whether landing.reuseGateReceipts is on (#9243): off by default; only an exact `true` turns it on. */
export function reuseGateReceiptsEnabled() {
  return loadMachineSettings().landing?.reuseGateReceipts === true;
}
