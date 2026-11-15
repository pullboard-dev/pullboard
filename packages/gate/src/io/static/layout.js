/** The layout ratchet as a static check class: a tracked file that raises a layout rule count is a finding [C7]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LAYOUT_BASELINE } from '../../../../codemap/index.js';
import { layoutCheck } from '../../../../codemap/index.js';

/**
 * The layout ratchet judged on one checked tree, as `path:line: message` rows.
 * Why: the checked tree's own baseline decides, never the tools copy's, so a baseline that only falls cannot be dodged by running from elsewhere.
 *
 * A tree with no layout baseline has not opted in: a user's plain project owns its own root entries [C7,#6544].
 *
 * @param {string} root - A Git checkout.
 * @returns {string[]} One row per failure; empty when no rule is above its baseline or the tree keeps no baseline.
 */
export function layoutProblems(root) {
  if (!existsSync(join(root, LAYOUT_BASELINE))) return [];
  try {
    layoutCheck(root, { baselineFile: join(root, LAYOUT_BASELINE) });
    return [];
  } catch (error) {
    if (!error.next) throw error;
    return error.message.split('\n').filter(Boolean).map(line => `${LAYOUT_BASELINE}:1: ${line} (next: ${error.next})`);
  }
}
