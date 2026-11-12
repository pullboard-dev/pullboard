#!/usr/bin/env node
/**
 * Find repository paths in code that do not exist [C7]: string arguments to join, resolve and new URL anchored on
 * import.meta.url, import.meta.dirname, dirname(fileURLToPath(import.meta.url)) or a repo-root variable, and array path
 * pieces such as ['packages', 'gate', 'src', ...]. Each finding names file:line and, when the missing path is a key of the
 * path map, the path it moved to. Only code is read: text inside strings (fixtures written into scratch repos) and prefix
 * checks are never findings, and neither are paths handed to a writer, which are about to exist.
 *
 * Why: most post-move reds were literal or segment-built paths that no longer existed. A ratchet records today's count per
 * file so the lint lands without blocking main; counts only fall.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPathMap } from '../../../../codemap/light.js';
import {
  lex,
  lineAt,
  walk,
} from '../scan.js';

const BASELINE = 'packages/gate/data/ceilings/missing-paths.json';
const ANCHOR_DIR = /^(?:import\.meta\.dirname|(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|fileURLToPath\(\s*new URL\(\s*['"`]\.['"`]\s*,\s*import\.meta\.url\s*\)\s*\))$/u;
const ROOT_NAMES = new Set(['REPO_ROOT', 'repoRoot', 'REPOSITORY_ROOT', 'repositoryRoot']);
const CALL = /(?<![\w$.])(?:path\.)?(?:join|resolve)\s*\(|(?<![\w$.])new\s+URL\s*\(/gu;
const WRITER = /\b(?:writeFileSync|writeFile|mkdirSync|mkdir|appendFileSync|appendFile|rmSync|rm|mkdtempSync|copyFileSync|copyFile|renameSync|rename|symlinkSync|cpSync|createWriteStream|ensureDir)\s*\(\s*$/u;
const PIECE = /^[\w@.-]+$/u;

/**
 * The index of the bracket that closes the one at `open`, over blanked code, or -1.
 *
 * @param {string} code - Source with strings and comments blanked.
 * @param {number} open - Index of an opening ( or [.
 * @returns {number} Index of the matching closer.
 */
function closing(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at += 1) {
    if ('([{'.includes(code[at])) depth += 1;
    else if (')]}'.includes(code[at])) { depth -= 1; if (depth === 0) return at; }
  }
  return -1;
}

/**
 * The top-level comma-separated ranges between an opener and its closer, trimmed.
 *
 * @param {string} code - Source with strings and comments blanked.
 * @param {number} open - Index of the opener.
 * @param {number} close - Index of its closer.
 * @returns {{start: number, end: number}[]} One range per element.
 */
function elements(code, open, close) {
  const out = [];
  let depth = 0;
  let from = open + 1;
  const push = end => {
    let start = from;
    while (start < end && /\s/u.test(code[start])) start += 1;
    let stop = end;
    while (stop > start && /\s/u.test(code[stop - 1])) stop -= 1;
    if (stop > start) out.push({ start, end: stop });
  };
  for (let at = open + 1; at < close; at += 1) {
    if ('([{'.includes(code[at])) depth += 1;
    else if (')]}'.includes(code[at])) depth -= 1;
    else if (code[at] === ',' && depth === 0) { push(at); from = at + 1; }
  }
  push(close);
  return out;
}

/**
 * Follow a path through the rename map to where it lives now.
 *
 * @param {Map<string,string>} map - Old path to new path.
 * @param {string} path - Repo-relative missing path.
 * @returns {string|null} The new path, or null when the map does not know it.
 */
function movedTo(map, path) {
  let current = path;
  const seen = new Set();
  while (map.has(current) && !seen.has(current)) { seen.add(current); current = map.get(current); }
  return current === path ? null : current;
}

/** The rename map as a Map, from an option, the committed shards or nothing. */
function renameMap(root, option) {
  if (option) return option instanceof Map ? option : new Map(Object.entries(option));
  try { return new Map(readPathMap(root)); } catch { return new Map(); }
}

/**
 * Findings of one source file.
 *
 * @param {string} root - Checkout root.
 * @param {string} file - Repo-relative file.
 * @param {string} source - File text.
 * @param {Set<string>} tops - First path segments that name repository folders, old or new.
 * @param {(path: string) => boolean} [exists] - Whether a path exists; a caching caller records every probe.
 * @returns {{line: number, path: string}[]} Missing paths with their lines.
 */
export function fileFindings(root, file, source, tops, exists = existsSync) {
  if (!/import\.meta|REPO_ROOT|repoRoot|REPOSITORY_ROOT|repositoryRoot|\[\s*['"`](?:packages|apps|src|test|bin|relay|docs)['"`]/u.test(source)) return [];
  const { code, strings } = lex(source);
  const literal = new Map(strings.map(entry => [entry.start, entry]));
  const here = dirname(resolve(root, file));
  const vars = new Map();
  const found = [];
  const seen = new Set();

  /** The text of a string literal that fills [start, end) exactly, or null. */
  const text = ({ start, end }) => {
    const entry = literal.get(start);
    return entry && entry.end === end && !entry.text.includes('${') && !/[*?]/u.test(entry.text) ? entry.text : null;
  };

  /** The absolute path a range names, when it is an anchor, a known variable or a join/resolve/new URL over those. */
  function evaluate(range) {
    const raw = source.slice(range.start, range.end);
    if (ANCHOR_DIR.test(raw)) return here;
    if (/^[A-Za-z_$][\w$]*$/u.test(raw)) {
      if (vars.has(raw)) return vars.get(raw);
      return ROOT_NAMES.has(raw) ? resolve(root) : null;
    }
    const head = /^(?:path\.)?(join|resolve)\s*\(|^new\s+URL\s*\(/u.exec(raw);
    if (!head) return null;
    const open = range.start + head[0].length - 1;
    const close = closing(code, open);
    if (close !== range.end - 1) return null;
    const args = elements(code, open, close);
    if (head[1]) {
      const base = evaluate(args[0] ?? { start: 0, end: 0 });
      const rest = args.slice(1).map(text);
      return base && rest.every(part => part !== null) ? resolve(base, ...rest) : null;
    }
    const target = args[0] && text(args[0]);
    if (target === null || target === undefined || args.length !== 2 || source.slice(args[1].start, args[1].end) !== 'import.meta.url' || /^[a-z][a-z0-9+.-]*:/iu.test(target)) return null;
    return resolve(here, target);
  }

  const inside = abs => abs === resolve(root) || abs.startsWith(resolve(root) + sep);
  const record = (offset, abs) => {
    if (!isAbsolute(abs) || !inside(abs) || exists(abs)) return;
    const path = relative(root, abs).split(sep).join('/');
    const line = lineAt(source, offset);
    if (!seen.has(`${line}:${path}`)) { seen.add(`${line}:${path}`); found.push({ line, path }); }
  };

  // A name declared more than once (function-local roots in one test file) is ambiguous and anchors nothing.
  const declaredAs = new Map();
  for (const declared of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/gu)) {
    const start = declared.index + declared[0].length;
    const stop = code.slice(start).search(/[;\n]/u);
    const value = evaluate({ start, end: stop < 0 ? code.length : start + stop }) ?? null;
    declaredAs.set(declared[1], declaredAs.has(declared[1]) && declaredAs.get(declared[1]) !== value ? null : value);
    if (declaredAs.get(declared[1]) !== null) vars.set(declared[1], value); else vars.delete(declared[1]);
  }

  for (const call of code.matchAll(CALL)) {
    const open = call.index + call[0].length - 1;
    const close = closing(code, open);
    if (close < 0 || WRITER.test(code.slice(Math.max(0, call.index - 80), call.index))) continue;
    const abs = evaluate({ start: call.index, end: close + 1 });
    if (abs === null || abs === undefined) continue;
    const first = elements(code, open, close)[0];
    const base = first && /^[A-Za-z_$][\w$]*$/u.test(source.slice(first.start, first.end)) ? vars.get(source.slice(first.start, first.end)) : null;
    // A missing root variable is reported where it is declared, not at every use.
    if (base && !exists(base)) continue;
    record(call.index, abs);
  }

  for (const array of code.matchAll(/\[/gu)) {
    const close = closing(code, array.index);
    if (close < 0) continue;
    const pieces = [];
    for (const element of elements(code, array.index, close)) {
      const piece = text(element);
      if (piece === null || !PIECE.test(piece)) break;
      pieces.push(piece);
    }
    // A list of names is not a path: an old-layout array needs a file name last, a new-layout one starts at a cell folder.
    const pathLike = ['packages', 'apps'].includes(pieces[0]) || /\.\w+$/u.test(pieces.at(-1) ?? '');
    if (pieces.length < 3 || tops.has(pieces[1]) || !tops.has(pieces[0]) || !pathLike || pieces.some(piece => piece === '..' || piece === '.')) continue;
    record(array.index, resolve(root, ...pieces));
  }
  return found;
}

/**
 * Every repository path in code under `root` that does not exist, with the path-map suggestion when known.
 *
 * @param {string} root - Checkout root.
 * @param {{map?: Map<string,string>|Record<string,string>, files?: string[], findingsOf?: typeof fileFindings}} [options] - Rename map, files to read, and a replacement for the per-file scan (a cache).
 * @returns {{file: string, line: number, path: string, suggest: string|null}[]} Findings sorted by file and line.
 */
export function missingPathFindings(root, options = {}) {
  const map = renameMap(root, options.map);
  const files = options.files ?? walk(root, /\.[cm]?js$/u);
  const tops = new Set(['packages', 'apps', 'src', 'test', 'bin', 'relay', 'docs', 'skills']);
  for (const key of map.keys()) tops.add(key.split('/')[0]);
  const rows = [];
  for (const file of files) {
    let source;
    try { source = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    for (const row of (options.findingsOf ?? fileFindings)(root, file, source, tops)) rows.push({ file, line: row.line, path: row.path, suggest: movedTo(map, row.path) });
  }
  return rows.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/**
 * The findings beyond what the ratchet records per file; the earliest rows of a file are the recorded ones.
 *
 * @param {{file: string, line: number, path: string, suggest: string|null}[]} rows - Findings sorted by file and line.
 * @param {{files: Record<string, number>}} baseline - Recorded count per file.
 * @returns {string[]} One `file:line: text` message per finding over the record.
 */
export function missingPathGrowth(rows, baseline) {
  const taken = new Map();
  const messages = [];
  for (const row of rows) {
    const used = (taken.get(row.file) ?? 0) + 1;
    taken.set(row.file, used);
    if (used > (baseline.files[row.file] ?? 0)) {
      messages.push(`${row.file}:${row.line}: repository path does not exist: ${row.path}${row.suggest ? ` (moved to ${row.suggest})` : ''}; fix the path, or record fewer findings in ${BASELINE} once fixed`);
    }
  }
  return messages;
}

/** The recorded per-file counts of the tree being checked. */
export function readMissingPathBaseline(root) {
  return JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
}

/**
 * Record today's count per file. The record only lowers: unless `initialize` is set, a file over its recorded count refuses.
 *
 * @param {string} root - Checkout root.
 * @param {{initialize?: boolean}} [options] - `initialize` allows the first write.
 * @returns {string[]} Refusals; empty when the record was written.
 */
export function writeMissingPathBaseline(root, { initialize = false } = {}) {
  const rows = missingPathFindings(root);
  if (!initialize) {
    const grown = missingPathGrowth(rows, readMissingPathBaseline(root));
    if (grown.length) return [`${BASELINE}:1: the ratchet only lowers; fix ${grown.length} finding(s) instead of recording them`];
  }
  const files = {};
  for (const row of rows) files[row.file] = (files[row.file] ?? 0) + 1;
  writeFileSync(join(root, BASELINE), `${JSON.stringify({ version: 1, total: rows.length, files }, null, 2)}\n`);
  return [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.find((arg, at) => at > 1 && !arg.startsWith('--')) ?? process.cwd());
  if (process.argv.includes('--write') || process.argv.includes('--initialize')) {
    const refused = writeMissingPathBaseline(root, { initialize: process.argv.includes('--initialize') });
    if (refused.length) { process.stdout.write(`${refused.join('\n')}\n`); process.exitCode = 1; }
  } else {
    const rows = missingPathFindings(root);
    process.stdout.write(rows.map(row => `${row.file}:${row.line}: ${row.path}${row.suggest ? ` -> ${row.suggest}` : ''}\n`).join(''));
    process.exitCode = rows.length ? 1 : 0;
  }
}
