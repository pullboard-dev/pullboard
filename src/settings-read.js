/** Read-only machine settings retain the same validation as admission, without loading writers [C7]. */
import { Refused } from './refused.js';
import { validateRunner } from './runner-registration.js';
import { relayCanaryProblem } from './relay-canary-config.js';
import { validateRunnerWaitMs } from './runner-wait.js';
import { machineSettingsFile } from './queue-settings.js';
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

