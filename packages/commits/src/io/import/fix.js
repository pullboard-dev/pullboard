/** Fix the one-import-binding-per-line style in the files a commit stages, so the gate never refuses for it [C7]. */
import { join } from 'node:path';
import { git } from '../../../../git/index.js';
import { gitSpawnSync } from '../../../../git/light.js';
import { splitImportBindings } from '../../logic/bindings.js';
import { stagedPaths } from '../hooks.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
const fs = fileSystemAdapter();

/**
 * Split a partly staged file's import lines in the index and in the working tree alike, so the staged bytes are fixed
 * and the unstaged edits stay unstaged (#5775). Why: refusing it left a style rule the author could only retry against.
 *
 * @param {string} root
 * @param {string} path
 * @returns {boolean} Whether the staged bytes changed.
 */
function fixPartlyStaged(root, path) {
  const shown = gitSpawnSync(['show', `:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (shown.status !== 0) return false;
  const staged = splitImportBindings(shown.stdout);
  if (!staged.changed) return false;
  const mode = git(root, ['ls-files', '-s', '--', path]).split(/\s/u)[0];
  if (!/^100[67]/u.test(mode)) return false;
  const blob = gitSpawnSync(['hash-object', '-w', '--stdin', `--path=${path}`], { cwd: root, encoding: 'utf8', input: staged.source });
  if (blob.status !== 0) return false;
  git(root, ['update-index', '--cacheinfo', `${mode},${blob.stdout.trim()},${path}`]);
  const working = splitImportBindings(fs.readFile(join(root, path), 'utf8'));
  if (working.changed) fs.writeFile(join(root, path), working.source);
  return true;
}

/**
 * Rewrite multi-binding import lines in the staged source files and stage the result. A partly staged file is fixed in
 * the index and the working tree alike, so no hunk its author left out is staged.
 *
 * @param {string} root
 * @returns {string[]} Notes for the person committing.
 */
export function fixStagedImportBindings(root) {
  const { written } = stagedPaths(root);
  const unstaged = new Set(git(root, ['diff', '--name-only', '-z']).split('\0').filter(Boolean));
  const fixed = [];
  const partly = [];
  for (const path of written) {
    if (!/^(?:src|packages|apps)\/.*\.[cm]?js$/u.test(path) || !fs.exists(join(root, path))) continue;
    if (!fs.lstat(join(root, path)).isFile()) continue; // Never follow a staged symlink to rewrite its target.
    if (unstaged.has(path)) { if (fixPartlyStaged(root, path)) partly.push(path); continue; }
    const before = fs.readFile(join(root, path), 'utf8');
    const { source, changed } = splitImportBindings(before);
    if (!changed) continue;
    fs.writeFile(join(root, path), source);
    fixed.push(path);
  }
  if (fixed.length) git(root, ['add', '--', ...fixed]);
  return [
    ...(fixed.length ? [`split multi-binding import lines in ${fixed.join(', ')} and staged them`] : []),
    ...(partly.length ? [`split multi-binding import lines in ${partly.join(', ')} in the index and the working tree; their unstaged edits stay unstaged`] : []),
  ];
}
