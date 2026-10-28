import { isAbsolute } from 'node:path';
/** Read-only machine settings retain the same validation as admission, without loading writers [C7]. */
import { Refused } from './refused.js';
import { machineSettingsFile } from './machine-home.js';
import { readMachineSettingsFile } from './queue-settings.js';
import { validateGateQueue } from './queue-settings.js';
const DEFAULT_GATE_SLOTS = 2;
const DEFAULT_BROWSER_SLOTS = 1;

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
  if (value.gate?.runnersOnly !== undefined && typeof value.gate.runnersOnly !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.runnersOnly in ${file} must be true or false`);
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
  const canaryProblem = relayCanaryProblem(value.relay?.canary);
  if (canaryProblem) throw new Refused('BAD_MACHINE_SETTINGS', `relay.canary in ${file} is invalid: ${canaryProblem}`);
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


/** Validate an SSH destination as one argument, never a command or an SSH option. */
export function validateRunner(value) {
  if (!value || typeof value.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(value.host)
    || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0 || value.browser > value.slots) {
    throw new Refused('BAD_RUNNER', 'use an SSH host or alias, positive --slots, and --browser from zero through slots');
  }
  if (value.gui !== undefined && value.gui !== null && typeof value.gui !== 'boolean') throw new Refused('BAD_RUNNER', 'runner gui must be true, false, or unknown');
  for (const key of ['node', 'root']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || /[\u0000-\u001f\u007f]/u.test(value[key])
      || !(value[key].startsWith('/') && value[key].length > 1 || key === 'node' && value[key] === 'node'))) {
      throw new Refused('BAD_RUNNER', `runner ${key} must be an absolute remote path${key === 'node' ? ' or node' : ''}`);
    }
  }
  return { host: value.host, slots: value.slots, browser: value.browser, ...(value.gui !== undefined ? { gui: value.gui } : {}),
    ...(value.node ? { node: value.node } : {}), ...(value.root ? { root: value.root } : {}) };
}


/** Validate only execution settings; credentials remain in the existing board link and device key store. */
export function relayCanaryConfig(value) {
  const problem = relayCanaryProblem(value);
  if (problem) throw new Refused('RELAY_CANARY_CONFIG', problem);
  return normalCanary(value);
}

/**
 * Name what is wrong with a stored canary setting, or return null when it is valid or absent.
 * Why: machine settings load on every move, so they report a bad canary as BAD_MACHINE_SETTINGS
 * without raising the canary command's own refusal from unrelated moves.
 */
function relayCanaryProblem(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || typeof value.root !== 'string' || !isAbsolute(value.root)
    || typeof value.agentId !== 'string' || !value.agentId || /\s/u.test(value.agentId)
    || Object.keys(value).some(key => !['enabled', 'root', 'agentId', 'deadlineMs'].includes(key))) {
    return 'configure a dedicated linked seat with pullboard relay canary on; credentials are never command arguments';
  }
  const deadlineMs = value.deadlineMs ?? 5000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 25000) {
    return 'set the canary timeout between 100 and 25000 milliseconds, below its one-minute cadence';
  }
  return null;
}

/** Copy only the known canary fields, defaulting the deadline; the value is already validated. */
function normalCanary(value) {
  if (value === undefined || value === null) return null;
  return { enabled: value.enabled, root: value.root, agentId: value.agentId, deadlineMs: value.deadlineMs ?? 5000 };
}

export const DEFAULT_RUNNER_WAIT_MS = 300_000;

/** Validate a machine's finite runner wait without allowing Node timer overflow. */
export function validateRunnerWaitMs(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnerWaitMs must be a positive whole number of milliseconds, at most 2147483647; run pullboard settings gate.runnerWaitMs <n>');
  }
  return value;
}
