/** A second cell entry may expose pure modules without admitting shell or opaque loading [C7,D3]. */
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { lex } from '../packages/kernel/index.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';

/** Read contained regular source bytes; a symbolic ancestor cannot supply a pure-entry proof. */
function sourceAt(root, file) {
  if (!/^[\w./-]+$/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return null;
  try {
    let path = root;
    for (const part of file.split('/')) {
      path = join(path, part);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (path === join(root, file) ? !stat.isFile() : !stat.isDirectory())) return null;
    }
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

/** Extract actual export-from operands, ignoring comments, strings and ordinary imports. */
function reexports(source) {
  const lexical = lex(source), result = [];
  for (const literal of lexical.strings) {
    if (!/\bexport\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^{}]*\})\s*from\s*$/u.test(lexical.code.slice(0, literal.start))) continue;
    result.push(...importsIn([`export * from ${source.slice(literal.start, literal.end)};`])[0]);
  }
  return result;
}

/** Validate the declared entry and its complete relative dependency closure without evaluating source. */
export function pureFrontDoorProblems(root, cell) {
  if (cell.pureFrontDoor === undefined) return [];
  const entry = cell.pureFrontDoor, directory = posix.dirname(cell.frontDoor), expected = `${directory}/core.js`;
  if (!directory.startsWith('packages/') || entry !== expected) return [`${cell.name} pureFrontDoor must be ${expected}`];
  const problems = [], queue = [entry], seen = new Set();
  const index = sourceAt(root, cell.frontDoor);
  try {
    if (index === null || !reexports(index).some(specifier => specifier.startsWith('.')
      && posix.normalize(posix.join(directory, specifier)) === entry)) {
      problems.push(`${cell.frontDoor} must re-export pure front door ${entry}`);
    }
  } catch { problems.push(`${cell.frontDoor} cannot prove its re-export of ${entry}`); }
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > 4096) { problems.push(`${entry} pure dependency closure exceeds 4096 files`); break; }
    const source = sourceAt(root, file);
    if (source === null) { problems.push(`${file} is not contained regular pure source for ${entry}`); continue; }
    let edges;
    try {
      edges = importsIn([source])[0];
      if (commonJsIn([source])[0]) problems.push(`${file} uses an opaque CommonJS loader in pure front door ${entry}`);
      if (file === entry) {
        const code = lex(source).code.replace(/\bexport\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^{}]*\})\s*from\s*(['"])\s*\1\s*;?/gu, '').trim();
        if (code || !edges.length) problems.push(`${entry} must only re-export modules under ${directory}/src/core/`);
      }
    } catch { problems.push(`${file} cannot be parsed as pure source for ${entry}`); continue; }
    for (const specifier of edges) {
      if (!specifier.startsWith('.')) { problems.push(`${file} reaches ${specifier} through pure front door ${entry}`); continue; }
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (/(?:^|\/)src\/shell(?:\/|$)/u.test(target) || file === entry && !target.startsWith(`${directory}/src/core/`)) {
        problems.push(`${file} reaches non-core file ${target} through pure front door ${entry}`);
      } else queue.push(target);
    }
  }
  return problems;
}
