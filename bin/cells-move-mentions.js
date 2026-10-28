/** Tell a fixture's module references to a moved source from the reads and copies a move must repoint [C7]. */

import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

const CANONICAL_COPIER = 'src/package-files.js';
const PLAN_DIRECTORY = new URL('./cells-plan/', import.meta.url);
let planned;

/**
 * The repository paths that are the canonical copier: src/package-files.js and, read from the committed cells plan
 * rather than hard-coded, the body it moves to. A lookalike module under the same package is not one of them.
 * @returns {Set<string>} Root-relative module paths.
 */
export function canonicalCopierPaths() {
  if (!planned) {
    planned = new Set([CANONICAL_COPIER]);
    for (const name of readdirSync(PLAN_DIRECTORY).filter(file => /\.json$/u.test(file))) {
      let cell;
      try { cell = JSON.parse(readFileSync(new URL(name, PLAN_DIRECTORY), 'utf8')); } catch { continue; }
      for (const row of Array.isArray(cell?.paths) ? cell.paths : []) if (row[0] === CANONICAL_COPIER && typeof row[1] === 'string') planned.add(row[1]);
    }
  }
  return planned;
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
 * @param {string[]} basenames - File names of the moved sources.
 * @param {string} file - The fixture's repository path, which resolves its relative import specifiers.
 * @param {(name: string, at: number) => boolean} provenCopier - True only when the callee at an offset is the imported, unshadowed binding.
 * @returns {Array<{start: number, end: number, text: string}>} The operational mentions.
 */
export function operationalMentions(source, scanned, basenames, provenCopier = () => false, file = '') {
  const { code, strings } = scanned;
  const copierNames = new Set();
  for (const match of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"](\.\.?\/[^'"]*)['"]/gu)) {
    // Only the repository's canonical copier counts: the specifier must resolve from this file to src/package-files.js.
    if (!canonicalCopierPaths().has(posix.normalize(posix.join(posix.dirname(file), match[2])))) continue;
    for (const entry of match[1].split(',')) {
      const named = /^\s*toolSourcePath(?:\s+as\s+([\w$]+))?\s*$/u.exec(entry);
      if (named) copierNames.add(named[1] ?? 'toolSourcePath');
    }
  }
  const ending = new RegExp(`(?:^|[/\\\\])(?:${basenames.map(escaped).join('|')})$`, 'u');
  const templates = strings.filter(row => source[row.start] === '`');
  return strings.filter(row => ending.test(row.text)).filter(row => {
    if (MODULE_BEFORE.test(code.slice(0, row.start))) return false;
    const calls = enclosingCalls(code, row.start);
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
