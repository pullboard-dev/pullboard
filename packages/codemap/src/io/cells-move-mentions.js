/** Tell a fixture's module references to a moved source from the reads and copies a move must repoint [C7]. */

import { fileSystemAdapter } from '../../../fs/index.js';
import { posix } from 'node:path';

const fs = fileSystemAdapter();

const CANONICAL_COPIER = 'src/package-files.js';
const PLAN_DIRECTORY = new URL('../../data/plan/', import.meta.url);
const REPOSITORY_ROOT = new URL('../../../../', import.meta.url);
let planned;

/**
 * The repository paths that are the canonical copier: src/package-files.js and, read from the committed cells plan
 * rather than hard-coded, the body it moves to and the owning cell's front door when that front door re-exports
 * toolSourcePath unrenamed from the body. Why the front door: once the shims go, importers reach the copier only
 * through it. A lookalike module under the same package is not one of them.
 * @returns {Set<string>} Root-relative module paths.
 */
export function canonicalCopierPaths() {
  if (!planned) {
    planned = new Set([CANONICAL_COPIER]);
    for (const name of fs.list(PLAN_DIRECTORY).filter(file => /\.json$/u.test(file))) {
      let cell;
      try { cell = JSON.parse(fs.readFile(new URL(name, PLAN_DIRECTORY), 'utf8')); } catch { continue; }
      for (const row of Array.isArray(cell?.paths) ? cell.paths : []) {
        if (row[0] !== CANONICAL_COPIER || typeof row[1] !== 'string') continue;
        planned.add(row[1]);
        if (frontDoorForwardsCopier(cell.frontDoor, row[1])) planned.add(cell.frontDoor);
      }
    }
  }
  return planned;
}

/**
 * Whether a cell's front door re-exports toolSourcePath under its own name straight from the copier body, so an
 * import through it binds the same function. A missing file, a rename or any other source is no forward.
 */
function frontDoorForwardsCopier(frontDoor, body) {
  if (typeof frontDoor !== 'string' || !/^packages\/[a-z-]+\/index\.js$/u.test(frontDoor)) return false;
  let source;
  try { source = fs.readFile(new URL(frontDoor, REPOSITORY_ROOT), 'utf8'); } catch { return false; }
  const specifier = `./${posix.relative(posix.dirname(frontDoor), body)}`;
  return source.split('\n').some(line => {
    const match = /^export\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2\s*;?\s*$/u.exec(line.trim());
    return Boolean(match && match[3] === specifier && match[1].split(',').some(name => name.trim() === 'toolSourcePath'));
  });
}

/** Escape one file name for a literal match inside a regular expression. */
function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Name every module-addressing context in which a moved path stays valid: the shim still resolves it. */
const MODULE_BEFORE = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*$/u;
const MODULE_THROUGH_JSON = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*\$\{\s*JSON\s*\.\s*stringify\s*\(\s*$/u;

/** Return the offset of the parenthesis that closes the call opened at an offset, or -1. */
function closing(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if ('([{'.includes(code[index])) depth++;
    else if (')]}'.includes(code[index]) && --depth === 0) return index;
  }
  return -1;
}

/** Find the call names, outermost last, whose argument list encloses an offset, stopping at the statement. */
function enclosingCalls(code, at) {
  const calls = [];
  let depth = 0;
  for (let index = at - 1; index >= 0 && calls.length < 12; index--) {
    const char = code[index];
    if (char === ')' || char === ']' || char === '}') depth++;
    else if (char === '(' || char === '[' || char === '{') {
      if (depth) { depth--; continue; }
      if (char !== '(') break;
      const callee = /(new\s+)?([\w$.]+)\s*$/u.exec(code.slice(0, index));
      calls.push(callee ? { name: callee[2].split('.').at(-1), member: callee[2].includes('.'), at: callee.index + callee[0].lastIndexOf(callee[2]), constructs: Boolean(callee[1]), open: index } : { name: '', member: false, at: -1, constructs: false, open: index });
    } else if (char === ';' && !depth) break;
  }
  return calls;
}

/**
 * List the string literals that name a moved source as a path a fixture could read or copy. A reference is not
 * operational when it only addresses a module (an import specifier, a file URL handed to a spawned program, a
 * template-built import, a constant used only that way) or goes through the shim-following copier.
 * @param {string} source - The fixture module text.
 * @param {{code: string, strings: Array<{start: number, end: number, text: string}>}} scanned - Its lexed form.
 * @param {string[]} paths - Repository-relative paths of the moved sources.
 * @param {Set<string>} copierNames - Local names of real import declarations that resolve to the canonical copier.
 * @param {(name: string, at: number) => boolean} provenCopier - True only when the callee at an offset is the imported, unshadowed binding.
 * @param {(name: string, at: number) => boolean} provenReader - True only for an imported, unshadowed native filesystem reader.
 * @param {(name: string, at: number) => boolean} provenOperation - An unshadowed direct native fs reader or pure path call.
 * @returns {Array<{start: number, end: number, text: string}>} The operational mentions.
 */
export function operationalMentions(source, scanned, paths, copierNames = new Set(), provenCopier = () => false, provenReader = () => false, provenOperation = () => false) {
  const { code, strings } = scanned;
  const ending = new RegExp(`(?:^|[/\\\\])(?:${paths.map(path => escaped(posix.basename(path))).join('|')})$`, 'u');
  const templates = strings.filter(row => source[row.start] === '`');
  // A relative fs operand is cwd-dependent. Any unevaluated dependency may change cwd before this reader runs.
  // Admit this shortcut only for a closed native fs/path module; source imports and dynamic loaders stay unproven.
  const closedNativeImports = !/\b(?:import|require)\s*\(/u.test(code)
    && strings.filter(row => /(?:\bfrom|\bimport)\s*$/u.test(code.slice(0, row.start)))
      .every(row => /^(?:node:)?(?:fs|path)$/u.test(row.text));
  // Arbitrary calls, tagged programs and an earlier filesystem operand can change cwd indirectly.
  // This shortcut recognizes only a closed sequence of compiler-bound native operations, never general JS.
  const operations = [...code.matchAll(/\(/gu)].map(match => {
    const callee = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*$/u.exec(code.slice(0, match.index));
    return callee && { name: callee[1], at: callee.index };
  });
  const closedOperations = !templates.length && operations.every(call => call && provenOperation(call.name, call.at));
  return strings.filter(row => ending.test(row.text)).filter(row => {
    if (MODULE_BEFORE.test(code.slice(0, row.start))) return false;
    const calls = enclosingCalls(code, row.start);
    // An unambiguous direct relative filename names the repository root, not another directory's same-named asset.
    // Keep indirect roots, path expressions and cwd mutation conservative: they may still resolve to the moved file.
    const direct = calls[0];
    if (closedNativeImports && closedOperations && direct && !direct.member && provenReader(direct.name, direct.at)
      && !operations.some(call => call.at < direct.at && provenReader(call.name, call.at))
      && !code.slice(direct.open + 1, row.start).trim() && !/\b(?:chdir|process|globalThis)\b/u.test(source)
      && /^(?:\.\/)?[\w.-]+$/u.test(row.text) && !row.text.includes('..')
      && !paths.some(path => posix.normalize(path) === posix.normalize(row.text))) return false;
    if (calls.some(call => !call.member && copierNames.has(call.name) && provenCopier(call.name, call.at))) return false;
    const toPath = calls.some(call => call.name === 'fileURLToPath');
    // A file URL is module addressing only once it is a string; the URL object itself is a valid filesystem operand.
    if (!toPath && calls.some(call => (call.name === 'pathToFileURL' || call.constructs && call.name === 'URL')
      && /^\s*\.\s*href\b/u.test(code.slice(closing(code, call.open) + 1)))) return false;
    const template = templates.filter(outer => outer.start < row.start && row.end <= outer.end).at(-1);
    if (template) {
      const open = source.lastIndexOf('${', row.start);
      if (open > template.start && MODULE_BEFORE.test(source.slice(template.start + 1, open))) return false;
    }
    const alias = [...code.slice(0, row.start).matchAll(/\bconst\s+([\w$]+)\s*=/gu)].at(-1);
    if (alias && !/[;\n]/u.test(code.slice(alias.index + alias[0].length, row.start))) {
      const uses = [...source.matchAll(new RegExp(`(?<![\\w$.])${escaped(alias[1])}(?![\\w$])`, 'gu'))]
        .filter(use => use.index !== alias.index + alias[0].indexOf(alias[1]));
      if (uses.length && uses.every(use => {
        const before = source.slice(Math.max(0, use.index - 80), use.index);
        return MODULE_THROUGH_JSON.test(before) || MODULE_BEFORE.test(before);
      })) return false;
    }
    return true;
  });
}
