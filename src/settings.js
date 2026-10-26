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
} from './resources.js';
import { validateRunner } from './runners.js';
import { Refused } from './refused.js';
import {
  DEFAULT_RUNNER_WAIT_MS,
  validateRunnerWaitMs,
} from './runner-wait.js';
import {
  carriedBrowserByLaunch,
  gateQueueSettings,
  machineSettingsFile,
  readMachineSettingsFile,
  validateGateQueue,
} from './queue-settings.js';

// The gate queue's settings live in queue-settings.js so the runner runtime can read them too.
export { gateQueueSettings, machineSettingsFile };

const DEFAULT_GATE_SLOTS = 2;
const DEFAULT_BROWSER_SLOTS = 1;
const DEFAULT_SHORT_SLOTS = 0;

/** Read and validate machine settings, preserving any unrelated settings. */
export function loadMachineSettings() {
  const file = machineSettingsFile();
  const value = readMachineSettingsFile(file);
  if (!value) return { gateSlots: DEFAULT_GATE_SLOTS, browserSlots: DEFAULT_BROWSER_SLOTS };
  if (value.gate?.runnerWaitMs !== undefined) validateRunnerWaitMs(value.gate.runnerWaitMs);
  if (value.landing !== undefined && (!value.landing || typeof value.landing !== 'object' || Array.isArray(value.landing)
    || Object.keys(value.landing).some(key => key !== 'pools') || !Array.isArray(value.landing.pools)
    || value.landing.pools.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/u.test(id)))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.pools in ${file} lists the board identifiers this machine may land`);
  }
  if (value.health?.sentinel !== undefined && typeof value.health.sentinel !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `health.sentinel in ${file} must be true or false`);
  }
  if (value.gate?.browserFreeChecks !== undefined && typeof value.gate.browserFreeChecks !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.browserFreeChecks in ${file} must be true or false`);
  }
  if (value.gate?.runnersFirst !== undefined && typeof value.gate.runnersFirst !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.runnersFirst in ${file} must be true or false`);
  }
  if (value.gate?.browserByLaunch !== undefined && typeof value.gate.browserByLaunch !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.browserByLaunch in ${file} must be true or false`);
  }
  validateGateQueue(value, file);
  if (value.view !== undefined && (!value.view || typeof value.view !== 'object' || Array.isArray(value.view)
    || (value.view.background !== undefined && typeof value.view.background !== 'boolean'))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `view in ${file} must be an object whose background is true or false; fix it before running Pullboard`);
  }
  if (value.relay?.offerAtInit !== undefined && typeof value.relay.offerAtInit !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `relay.offerAtInit in ${file} must be true or false`);
  }
  if (value.gate?.memoryFloorMB !== undefined && (!Number.isSafeInteger(value.gate.memoryFloorMB) || value.gate.memoryFloorMB < 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.memoryFloorMB in ${file} must be a whole number of megabytes, 0 or more; fix it before running Pullboard`);
  }
  const runners = value.runners ?? [];
  if (!Array.isArray(runners)) throw new Refused('BAD_MACHINE_SETTINGS', 'runners must be an array; use pullboard runner add <ssh-host> --slots <n> --browser <n>');
  const seen = new Set();
  for (const runner of runners) {
    validateRunner(runner);
    if (seen.has(runner.host)) throw new Refused('BAD_MACHINE_SETTINGS', 'runner hosts must be unique; remove the duplicate machine setting');
    seen.add(runner.host);
  }
  const gateSlots = value.gateSlots ?? DEFAULT_GATE_SLOTS;
  if (!Number.isSafeInteger(gateSlots) || gateSlots < 0 || gateSlots === 0 && runners.length === 0) {
    throw new Refused('BAD_GATE_SLOTS', `gateSlots in ${file} must be positive, or 0 with a registered runner; run pullboard runner add <ssh-host> --slots <n> --browser <n>`);
  }
  const browserSlots = value.browserSlots ?? DEFAULT_BROWSER_SLOTS;
  if (!Number.isSafeInteger(browserSlots) || browserSlots < 0 || browserSlots > gateSlots || browserSlots === 0 && runners.length === 0) {
    throw new Refused('BAD_BROWSER_SLOTS', `browserSlots in ${file} must be positive and no greater than gateSlots (${gateSlots}), or 0 with a registered runner; run pullboard settings browserSlots <n>`);
  }
  const shortSlots = value.gate?.shortSlots;
  if (shortSlots !== undefined && (!Number.isSafeInteger(shortSlots) || shortSlots < 0)) {
    throw new Refused('BAD_SHORT_SLOTS', `gate.shortSlots in ${file} must be a whole number, 0 or more; run pullboard settings gate.shortSlots <n>`);
  }
  return { ...value, gateSlots, browserSlots, ...(runners.length ? { runners } : {}) };
}

/** Browser-free check admission is deliberately opt-in per machine. */
export function browserFreeChecksEnabled() {
  return loadMachineSettings().gate?.browserFreeChecks === true;
}

/** Runner-first admission is machine-wide and remains off unless explicitly enabled. */
export function gateRunnersFirstEnabled() {
  return loadMachineSettings().gate?.runnersFirst === true;
}

/** Capture the runner wait deadline for a new run; later requeues retain that deadline. */
export function gateRunnerWaitMs() {
  return loadMachineSettings().gate?.runnerWaitMs ?? DEFAULT_RUNNER_WAIT_MS;
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
  });
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
