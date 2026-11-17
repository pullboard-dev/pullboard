/** The devices the relay roster records with their engines, as prepareEngineMove names a teammate who is behind [H17,#9828]. */
import { behindDeviceSetting } from './config.js';
import { boardPhones } from './roster.js';
import { joinedComputers } from './roster.js';

/**
 * The options that let a refused move name the teammate device running an older engine: none while engine.nameBehindDevice is off.
 * Why here: prepareEngineMove runs inside a synchronous board callback and a move never reads a setting, so the caller reads the setting and the
 * async roster first. A roster fault leaves the options empty, so it can never fail the move.
 *
 * @param {object} state - The board's relay link state.
 * @param {{ enabled?: () => boolean }} [ports] - The setting reader, replaceable by a caller.
 * @returns {Promise<{ nameBehindDevice?: true, behindDevices?: { device: string, seat: string, engine: number }[] }>}
 */
export async function behindDeviceOptions(state, { enabled = behindDeviceSetting } = {}) {
  if (enabled() !== true) return {};
  try {
    const computers = (await joinedComputers(state)).map(entry => ({ device: entry.name ?? `computer ${entry.machine.slice(-8)}`, seat: entry.machine, engine: entry.engine }));
    const phones = (await boardPhones(state)).filter(entry => !entry.revoked).map(entry => ({ device: `phone ${entry.deviceId.slice(-8)}`, seat: entry.deviceId, engine: entry.engine }));
    return { nameBehindDevice: true, behindDevices: [...computers, ...phones].filter(entry => entry.engine !== null) };
  } catch {
    return {};
  }
}
