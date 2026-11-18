/** The relay status this browser client knows, kept so a refused read can name its cause [H5,H17,C7]. */
import { relayUnavailableCause } from './notice.js';

let current = null;

/**
 * Remember the relay status the client was told, or forget it with null. Why: the refusal sites cannot learn the status
 * themselves, so whatever sets it later (nothing yet) feeds them through this one holder.
 * @param {{ relayOn?: boolean, machine?: string|null, excluded?: object|null, machines?: object[] }|null} status
 */
export function setRelayStatus(status) {
  current = status && typeof status === 'object' ? { ...status } : null;
}

/** The status last set, or null when none is (the default). */
export function getRelayStatus() {
  return current === null ? null : { ...current };
}

/**
 * Attach `relayCause` to a RELAY_UNAVAILABLE refusal, only when a status is set; any other refusal, and every refusal
 * while no status is set, comes back untouched.
 * @param {Error & { code?: string, relayCause?: object }} refusal
 * @returns {Error} The same refusal.
 */
export function attachRelayCause(refusal) {
  if (current === null || refusal?.code !== 'RELAY_UNAVAILABLE') return refusal;
  refusal.relayCause = relayUnavailableCause({ error: refusal, ...current });
  return refusal;
}

/**
 * The relay status a refused read needs, built from the exclusion list already loaded (#9765): `excluded` is the entry
 * naming the open board (by its board id, or by a listed name), else null. Pure; nothing calls it yet.
 * @param {{ openBoard?: string|null, exclusions?: object[]|null, machines?: object[]|null }} load
 * @returns {{ relayOn: true, machine: null, excluded: object|null, machines: object[] }}
 */
export function statusFromLoad({ openBoard = null, exclusions = [], machines = [] } = {}) {
  const entries = Array.isArray(exclusions) ? exclusions : [];
  const found = openBoard == null ? undefined : entries.find((entry) => entry?.board === openBoard || entry?.id === openBoard
    || entry?.name === openBoard || (Array.isArray(entry?.names) && entry.names.includes(openBoard)));
  const excluded = found ? { ...found, name: found.name ?? openBoard } : null;
  return { relayOn: true, machine: null, excluded, machines: machines ?? [] };
}
