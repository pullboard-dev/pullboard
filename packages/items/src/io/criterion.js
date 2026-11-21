/** List the cells a criterion can name from the project's package and app folders, without loading the analyzer or executing project modules [B35,C7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { join } from 'node:path';

const fs = fileSystemAdapter();

/** The names of the folders directly under `parent`, sorted; none when it is missing or unreadable. */
function folders(parent) {
  try { return fs.list(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort(); } catch { return []; }
}

/**
 * One row per package folder (named by the folder) and per app folder (named app:<name>) under the root, each with the folder as its root.
 * Why: the folders are the cells, so sizing an item needs no cells plan file and cannot refuse when one is missing or unreadable [C7,#2467].
 */
export function criterionCells(root) {
  return [
    ...folders(join(root, 'packages')).map(name => ({ name, root: `packages/${name}`, paths: [] })),
    ...folders(join(root, 'apps')).map(name => ({ name: `app:${name}`, root: `apps/${name}`, paths: [] })),
  ];
}
