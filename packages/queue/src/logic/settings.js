/** The gate queue's machine settings, parsed and checked without touching a file so a runner's trusted runtime can ship them [O5]. */
import { Refused } from '../../../kernel/browser.js';

/** Canonical coordinator identity shared by queue and configuration. */
export const COORDINATOR = 'coordinator';

/** A waiting run moves up one class after this many minutes, unless the machine sets agingMinutes. */
export const DEFAULT_QUEUE_AGING_MINUTES = 30;

/**
 * Parse machine settings text as a plain object, or null when the caller found no file. Why text and not a file:
 * resources.js runs on remote runners, whose trusted runtime ships only a few files, so the read stays with the
 * caller (machineSettingsFile() in the resources cell's machine-home.js) and the queue cell never reaches up into config.
 *
 * @param {string|null} text - The settings file's contents, or null when there is none.
 * @param {string} file - The settings file, for refusals.
 * @returns {object|null}
 */
export function parseMachineSettings(text, file) {
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); }
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
 * The gate pool's admission order from parsed machine settings. Reviews-first class order is opt-in per machine because it
 * changes who waits for whom on every board sharing the pool; absent or false keeps landings
 * first, then arrival. agingMinutes only matters while class order is on.
 *
 * @param {object|null} value - The parsed machine settings, or null when there are none.
 * @param {string} file - The settings file, for refusals.
 * @returns {{ reviewsFirst: boolean, currentReleaseFirst: boolean, agingMinutes: number }}
 */
export function gateQueueSettings(value, file) {
  const settings = value ?? {};
  validateGateQueue(settings, file);
  const queue = settings.gate?.queue;
  return { reviewsFirst: queue?.reviewsFirst === true, currentReleaseFirst: queue?.currentReleaseFirst === true, agingMinutes: queue?.agingMinutes ?? DEFAULT_QUEUE_AGING_MINUTES };
}
