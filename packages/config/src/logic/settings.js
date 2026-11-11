import { isAbsolute } from 'node:path';
/** Read-only machine settings retain the same validation as admission, without loading writers [C7]. */
import { validateCostPrices } from './prices.js';
import { Refused } from '../../../kernel/light.js';
import { machineSettingsFile } from '../../../resources/index.js';
import { readMachineSettingsFile } from '../../../queue/index.js';
import { validateGateQueue } from '../../../queue/index.js';
const DEFAULT_GATE_SLOTS = 2;
const DEFAULT_BROWSER_SLOTS = 1;

/**
 * Which slot counts this machine's settings state outright. An unset count is only the default, so a pool that a
 * runner's own jobs already sized keeps its recorded capacity instead (#2541).
 */
export function declaredMachineSlots() {
  const value = readMachineSettingsFile(machineSettingsFile());
  return { gate: value?.gateSlots !== undefined, browser: value?.browserSlots !== undefined };
}

/**
 * The optional spend ceiling: an object holding only dailyUsd and/or totalUsd, each a positive dollar amount. Off
 * when unset, so a machine with no budget spends without a ceiling [N2].
 *
 * @param {unknown} budget the budget value from the machine settings file
 * @param {string} file the settings file named in any refusal
 */
function validateBudget(budget, file) {
  if (budget === undefined) return;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).some(key => key !== 'dailyUsd' && key !== 'totalUsd')) {
    throw new Refused('BAD_MACHINE_SETTINGS', `budget in ${file} must be an object with dailyUsd and/or totalUsd; remove it to turn the spend ceiling off`);
  }
  for (const key of ['dailyUsd', 'totalUsd']) {
    if (budget[key] !== undefined && (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]) || budget[key] <= 0)) {
      throw new Refused('BAD_MACHINE_SETTINGS', `budget.${key} in ${file} must be a positive dollar amount; remove it to turn that ceiling off`);
    }
  }
}

/**
 * Where `pullboard serve` listens: a literal IPv4 address of one of this machine's interfaces and a port. Off the
 * loopback address the API needs the machine's board key, so runners on the network can pull jobs [P7,O5].
 *
 * @param {unknown} serve the serve value from the machine settings file
 * @param {string} file the settings file named in any refusal
 */
export function validateServe(serve, file) {
  if (serve === undefined) return;
  if (!serve || typeof serve !== 'object' || Array.isArray(serve) || Object.keys(serve).some(key => key !== 'address' && key !== 'port')) {
    throw new Refused('BAD_MACHINE_SETTINGS', `serve in ${file} holds only address and port; remove it to serve on loopback`);
  }
  const octets = typeof serve.address === 'string' ? serve.address.split('.') : [];
  if (serve.address !== undefined && (octets.length !== 4 || octets.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255) || serve.address === '0.0.0.0')) {
    throw new Refused('BAD_MACHINE_SETTINGS', `serve.address in ${file} must be one interface's literal IPv4 address, such as 192.168.1.98; remove it to serve on loopback`);
  }
  if (serve.port !== undefined && (!Number.isSafeInteger(serve.port) || serve.port < 0 || serve.port > 65535)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `serve.port in ${file} must be a port from 0 to 65535; 0 chooses a free one`);
  }
}

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
  if (value.gate?.handoffWorkers != null && (!Number.isSafeInteger(value.gate.handoffWorkers) || value.gate.handoffWorkers < 1)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.handoffWorkers in ${file} must be a whole number of 1 or more; remove it for the computed default`);
  }
  if (value.gate?.postLandSuite !== undefined && typeof value.gate.postLandSuite !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.postLandSuite in ${file} must be true or false`);
  }
  if (value.gate?.runnersFirst !== undefined && typeof value.gate.runnersFirst !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.runnersFirst in ${file} must be true or false`);
  }
  if (value.gate?.browserByLaunch !== undefined && typeof value.gate.browserByLaunch !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.browserByLaunch in ${file} must be true or false`);
  }
  if (value.gate?.measuredSlots !== undefined && typeof value.gate.measuredSlots !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.measuredSlots in ${file} must be true or false`);
  }
  if (value.gate?.loadAwareDispatch !== undefined && typeof value.gate.loadAwareDispatch !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', 'gate.loadAwareDispatch must be true or false');
  if (value.gate?.runnerBusyCeiling !== undefined && (!Number.isFinite(value.gate.runnerBusyCeiling) || value.gate.runnerBusyCeiling < 1 || value.gate.runnerBusyCeiling > 100)) throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnerBusyCeiling must be a percentage from 1 through 100');
  if (value.gate?.runnerDispatch !== undefined && !['controller', 'pull'].includes(value.gate.runnerDispatch)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.runnerDispatch in ${file} must be "controller" or "pull"`);
  }
  const pilot = value.gate?.pullPilot;
  if (pilot !== undefined && (!pilot || typeof pilot !== 'object' || Array.isArray(pilot) || Object.keys(pilot).some(key => !['items', 'share'].includes(key))
    || (pilot.items !== undefined && (!Array.isArray(pilot.items) || pilot.items.some(id => !Number.isSafeInteger(id) || id < 1)))
    || (pilot.share !== undefined && (!Number.isFinite(pilot.share) || pilot.share < 0 || pilot.share > 100)))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.pullPilot in ${file} must be { "items": [item numbers], "share": 0 through 100 }; remove it to send every submit through the controller path`);
  }
  if (value.gate?.submitAuthorization !== undefined && !['runner', 'local'].includes(value.gate.submitAuthorization)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.submitAuthorization in ${file} must be "runner" or "local"`);
  }
  if (value.gate?.mainComparison !== undefined && !['on-red', 'off'].includes(value.gate.mainComparison)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.mainComparison in ${file} must be "on-red" or "off"`);
  }
  const timingRunner = value.gate?.timingRunner;
  if (timingRunner !== undefined && timingRunner !== false && (typeof timingRunner !== 'string' || !timingRunner.trim() || timingRunner.trim() !== timingRunner)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.timingRunner in ${file} must be "auto", a registered runner host, or false`);
  }
  if (value.inspection?.clauses !== undefined && typeof value.inspection.clauses !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `inspection.clauses in ${file} must be true or false`);
  }
  validateServe(value.serve, file);
  validateGateQueue(value, file);
  validateCostPrices(value.costPrices);
  validateBudget(value.budget, file);
  if (value.view !== undefined && (!value.view || typeof value.view !== 'object' || Array.isArray(value.view)
    || (value.view.background !== undefined && typeof value.view.background !== 'boolean'))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `view in ${file} must be an object whose background is true or false; fix it before running Pullboard`);
  }
  if (value.relay?.offerAtInit !== undefined && typeof value.relay.offerAtInit !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `relay.offerAtInit in ${file} must be true or false`);
  }
  const canaryProblem = relayCanaryProblem(value.relay?.canary);
  if (canaryProblem) throw new Refused('BAD_MACHINE_SETTINGS', `relay.canary in ${file} is invalid: ${canaryProblem}`);
  const workerBudget = value.workers?.budget;
  if (workerBudget !== undefined && (!workerBudget || typeof workerBudget !== 'object' || Array.isArray(workerBudget)
    || !(typeof (workerBudget.spend ?? workerBudget.seatHours) === 'number' && Number.isFinite(workerBudget.spend ?? workerBudget.seatHours) && (workerBudget.spend ?? workerBudget.seatHours) >= 0)
    || !['day', 'week'].includes(workerBudget.window) || Object.keys(workerBudget).some(key => !['spend', 'seatHours', 'window'].includes(key))
    || (workerBudget.spend !== undefined && workerBudget.seatHours !== undefined))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `workers.budget in ${file} must be spend per day or week; run pullboard settings workers.budget 40/day`);
  }
  if (value.gate?.memoryFloorMB !== undefined && (!Number.isSafeInteger(value.gate.memoryFloorMB) || value.gate.memoryFloorMB < 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.memoryFloorMB in ${file} must be a whole number of megabytes, 0 or more; fix it before running Pullboard`);
  }
  if (value.gate?.diskFloorMB !== undefined && (!Number.isSafeInteger(value.gate.diskFloorMB) || value.gate.diskFloorMB < 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.diskFloorMB in ${file} must be a whole number of megabytes, 0 or more; fix it before running Pullboard`);
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
  if (value.publicKey !== undefined) {
    const key = value.publicKey;
    let der;
    try { der = typeof key === 'string' ? Buffer.from(key, 'base64url') : Buffer.alloc(0); }
    catch { der = Buffer.alloc(0); }
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{59}$/u.test(key) || der.length !== 44
      || der.toString('base64url') !== key || der.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') {
      throw new Refused('BAD_RUNNER', 'runner publicKey must be an enrolled Ed25519 SPKI key; run pullboard runner add <ssh-host>');
    }
  }
  for (const key of ['node', 'root']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || /[\u0000-\u001f\u007f]/u.test(value[key])
      || !(value[key].startsWith('/') && value[key].length > 1 || key === 'node' && value[key] === 'node'))) {
      throw new Refused('BAD_RUNNER', `runner ${key} must be an absolute remote path${key === 'node' ? ' or node' : ''}`);
    }
  }
  if (value.fixed !== undefined && typeof value.fixed !== 'boolean') throw new Refused('BAD_RUNNER', 'runner fixed must be true or false');
  for (const key of ['cores', 'memoryMB']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw new Refused('BAD_RUNNER', `runner ${key} must be a positive whole number measured on the runner`);
  }
  if (value.measuredAt !== undefined && !Number.isFinite(Date.parse(value.measuredAt))) throw new Refused('BAD_RUNNER', 'runner measuredAt must be a timestamp');
  if (value.cpuLoad !== undefined && !validRunnerCpuLoad(value.cpuLoad)) throw new Refused('BAD_RUNNER', 'runner CPU load requires its own timestamp, busy percentage and three load averages');
  return { host: value.host, ...(value.cpuLoad ? { cpuLoad: value.cpuLoad } : {}), slots: value.slots, browser: value.browser, ...(value.gui !== undefined ? { gui: value.gui } : {}),
    ...(value.publicKey ? { publicKey: value.publicKey } : {}),
    ...(value.node ? { node: value.node } : {}), ...(value.root ? { root: value.root } : {}),
    ...(value.fixed === true ? { fixed: true } : {}),
    ...(value.cores !== undefined && value.memoryMB !== undefined ? { cores: value.cores, memoryMB: value.memoryMB, ...(value.measuredAt !== undefined ? { measuredAt: value.measuredAt } : {}) } : {}) };
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

/** Validate a runner-published two-sample CPU observation without treating an absent reading as idle. */
export function validRunnerCpuLoad(value) {
  return value !== null && typeof value === 'object' && Number.isFinite(Date.parse(value.at))
    && Number.isFinite(value.busyPercent) && value.busyPercent >= 0 && value.busyPercent <= 100
    && Array.isArray(value.average) && value.average.length === 3 && value.average.every(n => Number.isFinite(n) && n >= 0);
}
