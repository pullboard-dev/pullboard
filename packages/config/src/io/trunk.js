/** Read the trunk remote board setting for the board host, its runners and the lander [P7]. */
import { loadConfig } from './main.js';
import { configTrunkRemote } from '../logic/trunk.js';

/**
 * The board's trunk remote from its pullboard.json (`trunk.remote`, else its old name `landing.trunkRemote`), or null
 * when unset or the board has no configuration.
 * Why one reader: runners fetch from it and the lander pushes to it, so both must name the same remote.
 *
 * @param {string} root - The board's repository root.
 * @returns {string | null}
 */
export function trunkRemote(root) {
  let config;
  try { config = loadConfig(root); } catch (error) { if (error?.code === 'NO_CONFIG') return null; throw error; }
  return configTrunkRemote(config);
}
