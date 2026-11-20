/** The declared cell rule: which cell may import which, the grandfathered upward edges and the cell order, read from one data file [C7,#2467]. */
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../fs/index.js';

const disk = fileSystemAdapter();
/** Where a tree declares the rule, relative to its root. */
export const CELL_RULE_FILE = 'packages/codemap/data/ceilings/allowed-edges.json';
const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_ROOT = join(HERE, '..', '..', '..', '..', '..');

/**
 * Read the declared cell rule of a tree.
 * Why: the allowed edges lived only in the restructure plan, which goes with the last Cells move; the rule outlives it [C7,#2467].
 *
 * @param {string} [root] The tree to read, default this checkout.
 * @returns {{ allowedEdges: string[], upwardEdgesGrandfathered: string[], cellOrder: string[] }} Edges as from->to, and cell names lowest first; all empty when the tree declares none.
 */
export function readCellRule(root = OWN_ROOT) {
  const path = join(root, CELL_RULE_FILE);
  const rule = disk.exists(path) ? JSON.parse(disk.readFile(path)) : {};
  return {
    allowedEdges: rule.allowedEdges ?? [],
    upwardEdgesGrandfathered: rule.upwardEdgesGrandfathered ?? [],
    cellOrder: rule.cellOrder ?? [],
  };
}
