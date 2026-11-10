/** Fix the one-import-binding-per-line style in the files a commit stages, so the gate never refuses for it [C7]. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../../git/index.js';
import { splitImportBindings } from '../../logic/bindings.js';
import { stagedPaths } from '../hooks.js';

/**
 * Rewrite multi-binding import lines in the fully staged source files and stage the result. A partly staged file is
 * left alone, since fixing it would stage hunks its author left out.
 *
 * @param {string} root
 * @returns {string[]} Notes for the person committing.
 */
export function fixStagedImportBindings(root) {
  const { written } = stagedPaths(root);
  const unstaged = new Set(git(root, ['diff', '--name-only', '-z']).split('\0').filter(Boolean));
  const fixed = [];
  for (const path of written) {
    if (!/^(?:src|packages|apps)\/.*\.[cm]?js$/u.test(path) || unstaged.has(path) || !existsSync(join(root, path))) continue;
    if (!lstatSync(join(root, path)).isFile()) continue; // Never follow a staged symlink to rewrite its target.
    const before = readFileSync(join(root, path), 'utf8');
    const { source, changed } = splitImportBindings(before);
    if (!changed) continue;
    writeFileSync(join(root, path), source);
    fixed.push(path);
  }
  if (fixed.length) git(root, ['add', '--', ...fixed]);
  return fixed.length ? [`split multi-binding import lines in ${fixed.join(', ')} and staged them`] : [];
}
