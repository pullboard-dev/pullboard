/** Which lane owns a path: the longest declared folder prefix wins [L1,L2]. */
import { COORDINATOR } from '../../../../queue/light.js';

/**
 * The lane that owns a path: the longest matching prefix wins; `./` is the repo root and matches every path. Paths no lane owns are the
 * coordinator's.
 *
 * @param {any} config
 * @param {string} path
 * @returns {string}
 */
export function laneOf(config, path) {
  let owner = COORDINATOR;
  let longest = -1;
  for (const [name, lane] of Object.entries(config.lanes)) {
    for (const prefix of lane.owns) {
      const root = prefix === './' || prefix === '.';
      const length = root ? 0 : prefix.length;
      if ((root || path.startsWith(prefix)) && length > longest) {
        owner = name;
        longest = length;
      }
    }
  }
  return owner;
}
