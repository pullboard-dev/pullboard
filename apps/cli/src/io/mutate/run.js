/** The mutation check's runner, bound to this app's pure fault and diff readers [C7]. */
import { mutateCell as mutateInCopy } from '../../../../../packages/sandbox/index.js';
import { faults } from '../../logic/mutate/faults.js';
import { changedLines } from '../../logic/mutate/lines.js';

/**
 * Seed faults in a throwaway copy of a cell and report which of its tests catch them.
 *
 * @param {string} root git checkout root
 * @param {string} cell cell folder relative to root
 * @param {{all?: boolean, base?: string}} [options]
 */
export async function mutateCell(root, cell, options) {
  return mutateInCopy(root, cell, options, { faults, changedLines });
}
