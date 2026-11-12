/** The layout ratchet as a static check class: a tracked file that raises a layout rule count is a finding [C7]. */
import { join } from 'node:path';
import { LAYOUT_BASELINE } from '../../../../codemap/index.js';
import { layoutCheck } from '../../../../codemap/index.js';

/**
 * The layout ratchet judged on one checked tree, as `path:line: message` rows.
 * Why: the checked tree's own baseline decides, never the tools copy's, so a baseline that only falls cannot be dodged by running from elsewhere.
 *
 * @param {string} root - A Git checkout.
 * @returns {string[]} One row per failure; empty when no rule is above its baseline.
 */
export function layoutProblems(root) {
  try {
    layoutCheck(root, { baselineFile: join(root, LAYOUT_BASELINE) });
    return [];
  } catch (error) {
    if (!error.next) throw error;
    return error.message.split('\n').filter(Boolean).map(line => `${LAYOUT_BASELINE}:1: ${line} (next: ${error.next})`);
  }
}
