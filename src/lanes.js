/**
 * Lanes (L1, L2): which folders each lane owns. The board, `pullboard lanes` and the pre-commit
 * lane check all read the same declaration in pullboard.json.
 */
import { COORDINATOR } from './config.js';

/**
 * Every lane name, the coordinator first.
 *
 * @param {any} config
 * @returns {string[]}
 */
export function laneNames(config) {
  return [COORDINATOR, ...Object.keys(config.lanes)];
}

/**
 * True for a lane the config declares, or the coordinator.
 *
 * @param {any} config
 * @param {string} name
 * @returns {boolean}
 */
export function isLane(config, name) {
  return name === COORDINATOR || Object.hasOwn(config.lanes, name);
}

/**
 * The lane that owns a path: the longest matching prefix wins. Paths no lane owns are the
 * coordinator's.
 *
 * @param {any} config
 * @param {string} path
 * @returns {string}
 */
export function laneOf(config, path) {
  let owner = COORDINATOR;
  let longest = 0;
  for (const [name, lane] of Object.entries(config.lanes)) {
    for (const prefix of lane.owns) {
      if (path.startsWith(prefix) && prefix.length > longest) {
        owner = name;
        longest = prefix.length;
      }
    }
  }
  return owner;
}

/**
 * The paths a lane may not change, each as `path (owner's)`. Shared paths are open to every lane,
 * and the coordinator may change anything.
 *
 * @param {any} config
 * @param {string} lane
 * @param {string[]} paths
 * @returns {string[]}
 */
export function outOfLane(config, lane, paths) {
  if (lane === COORDINATOR) return [];
  const isShared = (path) => config.shared.some((prefix) => path.startsWith(prefix));
  return paths
    .filter((path) => !isShared(path) && laneOf(config, path) !== lane)
    .map((path) => `${path} (${laneOf(config, path)}'s)`);
}
