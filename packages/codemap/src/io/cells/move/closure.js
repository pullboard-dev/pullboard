/** Prove the actual move declarations' bounded literal import closure without evaluating them [C7,H16]. */
import { isBuiltin } from 'node:module';
import { cellExistsSync as existsSync } from '../../cell/snapshot.js';
import { cellLstatSync as lstatSync } from '../../cell/snapshot.js';
import { cellReadFileSync as readFileSync } from '../../cell/snapshot.js';
import { cellReaddirSync as readdirSync } from '../../cell/snapshot.js';
import { join } from 'node:path';
import { posix } from 'node:path';
import { discovered } from '../../../../../kernel/index.js';
import { MOVE_CANDIDATE } from '../../../../../kernel/index.js';
import { MOVE_FILE } from '../../../../../kernel/index.js';
import { lex } from '../../../../../kernel/index.js';

/** Folders that hold move declarations: the src/moves shims while they last, then the moves cell's bodies [C7]. */
const MOVE_FOLDERS = Object.freeze(['src/moves', 'packages/moves/src/logic/moves', 'packages/moves/src/io/moves']);

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
  // Every existing moves folder is a root, so the closure survives src/moves being deleted (#2478).
  const folders = MOVE_FOLDERS.filter(folder => existsSync(join(root, folder)));
  if (!folders.length) throw new Error('unproven moves directory');
  for (const folder of folders) {
    const stat = lstatSync(join(root, folder));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unproven moves directory');
  }
  const pending = folders.flatMap(folder => discovered(readdirSync(join(root, folder)), MOVE_CANDIDATE, MOVE_FILE, 'move')
    .map(name => `${folder}/${name}`));
  if (!pending.length) throw new Error('no move declarations');
  return literalClosure(root, pending, { importsIn, commonJsIn, files }, 'move');
}

/**
 * The runner worker's bounded literal import closure, read through the repository inventory rather than the runners
 * cell, so the verify-side move check never imports a later cell (#1699). Opaque or unbounded source throws.
 */
export function runnerWorkerFiles(root, { importsIn, commonJsIn, files }, entry = 'apps/runner/src/io/scripts/worker.js') {
  return literalClosure(root, [entry], { importsIn, commonJsIn, files }, 'runner worker', urlSpecifiers);
}

/**
 * The relative files a source loads as `new URL('<literal>', import.meta.url)`, the runner package's runtime edges.
 * A two-argument URL whose base or first argument is not that exact literal shape is opaque and throws.
 */
function urlSpecifiers(source) {
  const { code, strings } = lex(source), found = [];
  for (const match of code.matchAll(/\bnew\s+URL\s*\(/gu)) {
    const start = match.index + match[0].length;
    let depth = 1, end = start;
    for (; end < code.length && depth; end += 1) depth += code[end] === '(' ? 1 : code[end] === ')' ? -1 : 0;
    const args = code.slice(start, end - 1);
    if (depth) throw new Error('opaque runner worker loader');
    if (!args.includes(',')) continue; // A one-argument URL names no source-relative file.
    const tail = /,\s*import\s*\.\s*meta\s*\.\s*url\s*$/u.exec(args);
    const literal = tail && strings.find(entry => entry.start === start + args.search(/\S/u));
    if (!literal || !['"', "'"].includes(source[literal.start]) || code.slice(literal.end, start + tail.index).trim()) throw new Error('opaque runner worker loader');
    found.push(literal.text);
  }
  return found;
}

/** Walk relative literal imports from the starting files, refusing loaders, bare or non-module dependencies and size overruns. */
function literalClosure(root, pending, { importsIn, commonJsIn, files }, label, extra = () => []) {
  const allowed = new Set(files);
  const reached = new Set();
  const via = new Map();
  let bytes = 0;
  while (pending.length) {
    const level = [...new Set(pending)].filter(file => !reached.has(file));
    pending = [];
    const sources = level.map(file => {
      reached.add(file);
      const source = sourceAt(root, file, allowed);
      bytes += Buffer.byteLength(source);
      if (reached.size > 4096 || bytes > 1_048_576) throw new Error(`${label} closure exceeds source bounds (4096 files or 1 MiB)`);
      return source;
    });
    if (commonJsIn(sources).some(Boolean)) throw new Error(`opaque ${label} loader`);
    const edges = importsIn(sources);
    for (const [index, imports] of edges.entries()) for (const specifier of [...imports, ...extra(sources[index])]) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`non-literal relative ${label} import`);
      const target = posix.normalize(posix.join(posix.dirname(level[index]), specifier));
      if (!/\.[cm]?js$/u.test(target)) {
        const chain = [level[index]];
        for (let at = via.get(chain[0]); at && chain.length < 12; at = via.get(at)) chain.unshift(at);
        throw new Error(`unproven executable ${label} dependency ${specifier} imported through ${chain.join(' > ')}`);
      }
      if (!via.has(target)) via.set(target, level[index]);
      pending.push(target);
    }
  }
  return reached;
}
