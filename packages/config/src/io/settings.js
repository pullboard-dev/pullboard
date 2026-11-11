/** Machine-wide settings shared by every Pullboard checkout on this machine. */
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  setResourceCapacity,
  updateRunnerSettings,
} from '../../../resources/index.js';
import { validateRunner } from '../logic/settings.js';
import { loadMachineSettings } from '../logic/settings.js';
export { loadMachineSettings };
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

/** Set the runner deadline for new work without changing any admitted or queued run. */
export function setGateRunnerWaitMs(milliseconds) {
  validateRunnerWaitMs(milliseconds);
  const current = loadMachineSettings();
  const next = { ...current, gate: { ...current.gate, runnerWaitMs: milliseconds } };
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
 * How a runner job is watched: `controller` holds one process per job until its result, `pull` waits on a shared status
 * mirror in the caller [C7,#5465]. Anything but an exact `pull` is the default, so a damaged value never changes dispatch.
 */
export function runnerDispatchMode() {
  return loadMachineSettings().gate?.runnerDispatch === 'pull' ? 'pull' : 'controller';
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
  const next = { ...settings, landing: { pools: [...pools].sort() } };
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
