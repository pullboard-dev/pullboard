/** Prove the actual move declarations' bounded literal import closure without evaluating them [C7,H16]. */
import { isBuiltin } from 'node:module';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { discovered } from '../packages/kernel/index.js';
import { MOVE_CANDIDATE } from '../packages/kernel/index.js';
import { MOVE_FILE } from '../packages/kernel/index.js';

/** Folders that hold move declarations: the src/moves shims while they last, then the moves cell's bodies [C7]. */
const MOVE_FOLDERS = Object.freeze(['src/moves', 'packages/moves/src/core/moves', 'packages/moves/src/shell/moves']);

/** Refuse symlinks, absent modules and paths outside the finite repository source capability. */
function sourceAt(root, file, allowed) {
  if (!allowed.has(file) || !/^[\w./-]+$/u.test(file)
    || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unproven move source');
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (path === join(root, file) ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('non-regular move source');
    }
  }
  return readFileSync(path, 'utf8');
}

/** Return only a complete finite declaration closure; opaque or unbounded source grants no exception. */
export function moveDeclarationFiles(root, { importsIn, commonJsIn, files }) {
  const allowed = new Set(files);
  // Every existing moves folder is a root, so the closure survives src/moves being deleted (#2478).
  const folders = MOVE_FOLDERS.filter(folder => existsSync(join(root, folder)));
  if (!folders.length) throw new Error('unproven moves directory');
  for (const folder of folders) {
    const stat = lstatSync(join(root, folder));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unproven moves directory');
  }
  let pending = folders.flatMap(folder => discovered(readdirSync(join(root, folder)), MOVE_CANDIDATE, MOVE_FILE, 'move')
    .map(name => `${folder}/${name}`));
  if (!pending.length) throw new Error('no move declarations');
  const reached = new Set();
  let bytes = 0;
  while (pending.length) {
    const level = [...new Set(pending)].filter(file => !reached.has(file));
    pending = [];
    const sources = level.map(file => {
      reached.add(file);
      const source = sourceAt(root, file, allowed);
      bytes += Buffer.byteLength(source);
      if (reached.size > 4096 || bytes > 1_048_576) throw new Error('move closure exceeds source bounds');
      return source;
    });
    if (commonJsIn(sources).some(Boolean)) throw new Error('opaque move loader');
    const edges = importsIn(sources);
    for (const [index, imports] of edges.entries()) for (const specifier of imports) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error('non-literal relative move import');
      const target = posix.normalize(posix.join(posix.dirname(level[index]), specifier));
      if (!/\.[cm]?js$/u.test(target)) throw new Error('unproven executable move dependency');
      pending.push(target);
    }
  }
  return reached;
}
