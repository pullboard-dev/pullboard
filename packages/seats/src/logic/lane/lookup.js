/** Which lane owns a path: the longest declared folder prefix wins [L1,L2]. */
import { COORDINATOR } from '../../../../queue/light.js';

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
