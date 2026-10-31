/** Prove the actual move declarations' bounded literal import closure without evaluating them [C7,H16]. */
import { isBuiltin } from 'node:module';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { importsIn, commonJsIn } from '../src/module-imports.js';
import { createRunnerModuleParser } from '../src/runner-module-parser.js';
import { packageFiles } from '../src/package-files.js';
import { discovered, MOVE_CANDIDATE, MOVE_FILE } from '../src/discovery.js';

/** Refuse symlinks, absent modules and paths outside the shipped source capability. */
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
export function moveDeclarationFiles(root) {
  const allowed = new Set(packageFiles(root));
  const directory = join(root, 'src/moves');
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('unproven moves directory');
  let pending = discovered(readdirSync(directory), MOVE_CANDIDATE, MOVE_FILE, 'move')
    .map(name => `src/moves/${name}`);
  if (!pending.length) throw new Error('no move declarations');
  const files = new Set();
  let bytes = 0;
  const parser = createRunnerModuleParser();
  try {
    while (pending.length) {
      const level = [...new Set(pending)].filter(file => !files.has(file));
      pending = [];
      const sources = level.map(file => {
        files.add(file);
        const source = sourceAt(root, file, allowed);
        bytes += Buffer.byteLength(source);
        if (files.size > 4096 || bytes > 1_048_576) throw new Error('move closure exceeds source bounds');
        return source;
      });
      if (commonJsIn(sources, parser.parse).some(Boolean)) throw new Error('opaque move loader');
      const edges = importsIn(sources, parser.parse);
      for (const [index, imports] of edges.entries()) for (const specifier of imports) {
        if (isBuiltin(specifier)) continue;
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error('non-literal relative move import');
        const target = posix.normalize(posix.join(posix.dirname(level[index]), specifier));
        if (!/\.[cm]?js$/u.test(target)) throw new Error('unproven executable move dependency');
        pending.push(target);
      }
    }
    return files;
  } finally { parser.close(); }
}
