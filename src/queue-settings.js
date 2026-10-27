/** The gate queue's machine settings, read with node: built-ins only so a runner's trusted runtime can ship them [O5]. */
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { machineHome } from './machine-home.js';
import { Refused } from './refused.js';

/** A waiting run moves up one class after this many minutes, unless the machine sets agingMinutes. */
export const DEFAULT_QUEUE_AGING_MINUTES = 30;

/**
 * The test classifier override this process inherited, or null when it inherited none. A run started
 * on a runner carries the classification its controller used, so the runner never reclassifies from its
 * own machine settings (#1043).
 *
 * @returns {boolean|null}
 */
export function carriedBrowserByLaunch() {
  const carried = process.env.PULLBOARD_TEST_BROWSER_BY_LAUNCH;
  return carried === '1' ? true : carried === '0' ? false : null;
}

/** Resolve the separate machine settings file. */
export function machineSettingsFile() {
  return join(machineHome(), 'settings.json');
}

/**
 * Read the machine settings file as a plain object, or null when there is none. Why here and not
 * in settings.js: resources.js runs on remote runners, whose trusted runtime ships only a few
 * files, and settings.js imports runners.js and resources.js.
 *
 * @param {string} [file]
 * @returns {object|null}
 */
export function readMachineSettingsFile(file = machineSettingsFile()) {
  if (!existsSync(file)) return null;
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('BAD_MACHINE_SETTINGS', `cannot read ${file}; fix its JSON before running Pullboard`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `settings in ${file} must be a JSON object; fix it before running Pullboard`);
  }
  if (value.gate !== undefined && (!value.gate || typeof value.gate !== 'object' || Array.isArray(value.gate))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate in ${file} must be an object; fix it before running Pullboard`);
  }
  return value;
}

/**
 * Refuse an unusable gate.queue setting by name, with the fix.
 *
 * @param {object} value - The parsed machine settings.
 * @param {string} file - The settings file, for the message.
 */
export function validateGateQueue(value, file) {
  const queue = value.gate?.queue;
  if (queue !== undefined && (!queue || typeof queue !== 'object' || Array.isArray(queue))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.queue in ${file} must be an object; fix it before running Pullboard`);
  }
  if (queue?.reviewsFirst !== undefined && typeof queue.reviewsFirst !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.queue.reviewsFirst in ${file} must be true or false`);
  }
  if (queue?.currentReleaseFirst !== undefined && typeof queue.currentReleaseFirst !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.queue.currentReleaseFirst in ${file} must be true or false`);
  }
  if (queue?.agingMinutes !== undefined && (!Number.isSafeInteger(queue.agingMinutes) || queue.agingMinutes < 1)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.queue.agingMinutes in ${file} must be a positive whole number of minutes; fix it or remove it for the default ${DEFAULT_QUEUE_AGING_MINUTES}`);
  }
}

/**
 * The gate pool's admission order. Reviews-first class order is opt-in per machine because it
 * changes who waits for whom on every board sharing the pool; absent or false keeps landings
 * first, then arrival. agingMinutes only matters while class order is on.
 *
 * @returns {{ reviewsFirst: boolean, currentReleaseFirst: boolean, agingMinutes: number }}
 */
export function gateQueueSettings() {
  const file = machineSettingsFile();
  const value = readMachineSettingsFile(file) ?? {};
  validateGateQueue(value, file);
  const queue = value.gate?.queue;
  return { reviewsFirst: queue?.reviewsFirst === true, currentReleaseFirst: queue?.currentReleaseFirst === true, agingMinutes: queue?.agingMinutes ?? DEFAULT_QUEUE_AGING_MINUTES };
}

/** Board-owned controller inputs; false means off, independently of machine gate settings. */
export const LINE_SETTING_DEFINITIONS = Object.freeze({
  order: Object.freeze({ type: 'boolean' }),
  focusMilestone: Object.freeze({ type: 'milestone' }),
  reviewsFirst: Object.freeze({ type: 'boolean' }),
  requireReviewFamilies: Object.freeze({ type: 'boolean' }),
  wipPerReviewer: Object.freeze({ type: 'number', min: 1.5, max: 3, integer: false }),
  barReady: Object.freeze({ type: 'boolean' }),
  'bar.check': Object.freeze({ type: 'boolean' }),
  'bar.sharpenToPerson': Object.freeze({ type: 'boolean' }),
  takeoverMinutes: Object.freeze({ type: 'number', min: 15, max: 60, integer: true }),
  collisionFreeBatch: Object.freeze({ type: 'boolean' }),
  landingBatchSize: Object.freeze({ type: 'number', min: 1, max: 8, integer: true }),
  landingCadenceMinutes: Object.freeze({ type: 'number', min: 5, max: 30, integer: true }),
});

/** Refuse unknown controls and out-of-range values without changing any live queue behavior. */
export function validateLineSetting(key, value) {
  if (!Object.hasOwn(LINE_SETTING_DEFINITIONS, key)) throw new Refused('LINE_SETTING_UNKNOWN', 'choose a known board line setting from pullboard settings line');
  validateKnownLineSetting(key, value);
}

/** Validate a value after the caller establishes its key belongs to the shared registry. */
export function validateKnownLineSetting(key, value) {
  const definition = LINE_SETTING_DEFINITIONS[key];
  if (value === false || definition.type === 'boolean' && value === true) return;
  if (definition.type === 'milestone' && typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\r\n]/u.test(value)) return;
  if (definition.type === 'number' && typeof value === 'number' && Number.isFinite(value)
    && value >= definition.min && value <= definition.max && (!definition.integer || Number.isSafeInteger(value))) return;
  throw new Refused('LINE_SETTING_RANGE', `${key} accepts off or ${definition.type === 'boolean' ? 'on' : definition.type === 'milestone' ? 'a milestone name' : `${definition.integer ? 'whole numbers ' : 'numbers '}${definition.min} to ${definition.max}`}; read pullboard settings line`);
}
