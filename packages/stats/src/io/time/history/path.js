/** Where the stats history file lives: path naming kept apart from the module that writes it [R1,C7]. */
import { join } from 'node:path';
import { STATS_HISTORY_FILE } from '../history.js';

/**
 * The history file under a repo's common dir: the one place its path is built [C7].
 *
 * @param {string} commonDir
 * @returns {string}
 */
export function statsHistoryFile(commonDir) {
  return join(commonDir, 'pullboard', STATS_HISTORY_FILE);
}
