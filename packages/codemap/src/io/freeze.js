#!/usr/bin/env node
/**
 * The freeze script: applies the layout rename table in one scripted change [V32,V33].
 * Why: moving thousands of files by parallel items breaks every branch in flight (the 0.9.3 Cells lesson), so one script
 * moves, joins, deletes and rewrites everything in a short freeze while the lander is paused and the seats are idle.
 *
 * Usage: node freeze.js [--root <checkout>] [--table <renames.tsv>] [--dry-run] [--json] [--scan <folder>]...
 * Rows of the table: `old<TAB>new`, `old<TAB>delete<TAB>importers -> <door>`, `old<TAB>merge:<path>`.
 * The run needs a clean tree, changes nothing under --dry-run, and a second run finds every row done and does nothing.
 */
/** @pullboard-module-loads packages/gate/src/io/edges.js */
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { posix } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { storeName } from './store-names.js';
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();

const TABLES = ['packages/codemap/data/plan/renames.tsv', 'packages/codemap/data/plan/plan/renames.tsv'];
const HISTORY = /(^|\/)(?:move-history|history)\/\d+\.json$/u;
const DOCS = /^(?:SPEC|README|DOCTRINE|AGENTS|COORDINATOR|CONTRIBUTING|SECURITY)\.md$|^docs\/.*\.md$/u;
const DOC_LISTED = new Set(['SPEC.md', 'README.md', 'DOCTRINE.md']);
const NEVER_REWRITE = /^CHANGELOG\.md$/u;
const PATH_MAP_SHARD = /(?:^|\/)path-map\/[a-z][a-z0-9-]*\.json$/u;
const MOVE_TOOL_TEST = /(?:move|path-map|rename|shim|freeze|layout)[^/]*[.]test[.][a-z]+$|\/fixtures\/.*move/u;
const TEXT_EXTENSION = /\.(?:m?js|cjs|json|md|txt|yml|yaml|css|html|webmanifest|tsv|gitignore)$|(?:^|\/)(?:pre-commit|commit-msg|pre-push|Dockerfile)$/u;
const TOKEN = /(?:(?<![\w./@-])|(?<=["'`]\.\/))\.?[\w@-][\w@.-]*(?:\/\.?[\w@-][\w@.-]*)*/gu;
const SEGMENTS = /(['"])[\w@.-]+\1(?:\s*,\s*(['"])[\w@.-]+\2)+/gu;
const LITERAL = /(['"`])(\.{1,2}\/[\w@./-]+)\1/gu;
const SPECIFIER_CONTEXT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*|\bnew URL\(\s*)$/u;
const ESCAPED = /(?<![\w./@\\-])[\w@-][\w@.-]*(?:\\\/[\w@.-]+)+/gu;
const SPECIFIERS = [
  /(\b(?:import|export)\b[^'"`;()]*?\bfrom\s*)(['"])([^'"\n]+)\2/gu,
  /(\bimport\s*)(['"])([^'"\n]+)\2/gu,
  /(\bimport\(\s*)(['"])([^'"\n]+)\2/gu,
  /(\brequire\(\s*)(['"])([^'"\n]+)\2/gu,
  /(\bnew URL\(\s*)(['"])([^'"\n]+)\2(?=\s*,\s*import\.meta\.url)/gu,
];
const NAMED_IMPORT = /(\b(?:import|export)\s*)\{([^}]*)\}(\s*from\s*)(['"])([^'"\n]+)\4/gu;
const CELL = /^((?:apps|packages)\/[^/]+)\/(.*)$/u;

/** Hash bytes the way the cell lint store does. */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** A refusal in the house shape. */
function refuse(code, message, next) { return new Refused(code, `${message}; ${next}`, next); }

/**
 * Read the rename table.
 *
 * @param {string} text The table file.
 * @returns {{ old: string, kind: 'move'|'delete'|'merge', to: string }[]} One entry per row that does something.
 */
export function parseTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [old, second, third = ''] = line.split('\t');
    if (!old || !second) throw refuse('FREEZE_TABLE', `malformed table row "${line}"`, 'regenerate the rename table');
    if (second === 'delete') {
      const door = /->\s*(\S+)\s*$/u.exec(third)?.[1];
      if (!door) throw refuse('FREEZE_TABLE', `delete row for ${old} names no door`, 'write "importers -> <door>" in the third column');
      rows.push({ old, kind: 'delete', to: door });
    } else if (second.startsWith('merge:')) rows.push({ old, kind: 'merge', to: second.slice(6) });
    else if (second !== old) rows.push({ old, kind: 'move', to: second });
  }
  return rows;
}

/** The files Git tracks, as a sorted array. */
function trackedFiles(root) {
  const listed = tryGit(root, ['ls-files', '--cached', '-z']);
  if (listed.status !== 0) throw refuse('FREEZE_NO_GIT', 'the freeze reads tracked files from Git', 'run it inside a Git checkout');
  return listed.stdout.split('\0').filter(Boolean).sort();
}

/** Sort every key of a plain object the way `compare` orders them. */
function sortedBy(object, compare) { return Object.fromEntries(Object.entries(object).sort(([a], [b]) => compare(a, b))); }

/** Whether the keys already run in ascending order under `compare`. */
function ordered(keys, compare) { return keys.every((key, at) => at === 0 || compare(keys[at - 1], key) <= 0); }

/**
 * Work out what the table does to this tree: which rows are pending, which are already done.
 *
 * @param {Set<string>} tracked Tracked paths.
 * @param {{ old: string, kind: string, to: string }[]} rows
 * @returns {{ moves: Map<string, string>, merges: Map<string, string>, deletes: Map<string, string>, done: number, missing: string[] }}
 */
export function planRows(tracked, rows) {
  const moves = new Map(), merges = new Map(), deletes = new Map(), missing = [];
  let done = 0;
  for (const row of rows) {
    if (tracked.has(row.old)) {
      ({ move: moves, merge: merges, delete: deletes })[row.kind].set(row.old, row.to);
    } else if (row.kind === 'delete' || tracked.has(row.to)) done += 1;
    else missing.push(row.old);
  }
  return { moves, merges, deletes, done, missing };
}

/**
 * Directories whose files move to one new directory, so a path naming the folder follows it.
 * A folder that splits follows the destination that takes most of its files, and is listed as split.
 */
function directoryMoves(tracked, moves, split = []) {
  const counts = new Map(), totals = new Map();
  for (const file of tracked) {
    const dir = posix.dirname(file);
    totals.set(dir, (totals.get(dir) ?? 0) + 1);
    const target = moves.get(file);
    if (!target) continue;
    const row = counts.get(dir) ?? new Map();
    row.set(posix.dirname(target), (row.get(posix.dirname(target)) ?? 0) + 1);
    counts.set(dir, row);
  }
  const dirs = new Map();
  for (const [dir, row] of counts) {
    const [best, most] = [...row].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (best === dir || most * 2 <= totals.get(dir)) continue;
    dirs.set(dir, best);
    if (most < totals.get(dir)) split.push(`${dir} -> ${best} (${most} of ${totals.get(dir)} files)`);
  }
  return dirs;
}

/**
 * A function that rewrites old repository paths inside any text to their new places.
 * Tokens that are not whole path-like words are left alone; a trailing dot or hyphen belongs to the prose.
 *
 * @param {Map<string, string>} paths Old file path to new file path.
 * @param {Map<string, string>} dirs Old directory to new directory.
 * @returns {(text: string, log?: Function) => string}
 */
export function pathRewriter(paths, dirs) {
  const find = (word, exact = false) => {
    for (const cut of [word, word.replace(/[-.]+$/u, '')]) {
      if (!cut) continue;
      if (paths.has(cut)) return [cut, paths.get(cut)];
      if (exact) continue;
      const parts = cut.split('/');
      for (let used = parts.length; used >= 1; used -= 1) {
        if (used === 1 && parts.length === 1) break;
        const dir = parts.slice(0, used).join('/');
        const rest = parts.slice(used);
        if (rest.length === 1 && rest[0].length <= 3 && !rest[0].includes('.')) continue;
        if (dirs.has(dir)) return [cut, [dirs.get(dir), ...parts.slice(used)].join('/')];
      }
    }
    return null;
  };
  return (text, log = () => {}, { segments = false, dotted = null } = {}) => {
    const joined = segments ? text.replace(SEGMENTS, (run, at) => {
      const parts = [...run.matchAll(/(['"])([\w@.-]+)\1/gu)].map(match => match[2]);
      const hit = find(parts.join('/'));
      if (!hit || hit[0] !== parts.join('/')) return run;
      log(hit[0], hit[1], text.slice(0, at).split('\n').length);
      const quote = run[0];
      return hit[1].split('/').map(part => `${quote}${part}${quote}`).join(', ');
    }) : text;
    const plain = joined.replace(TOKEN, (word, at) => {
      const hit = find(word, dotted !== null && joined.slice(at - 2, at) === './');
      if (hit && dotted !== null && joined.slice(at - 2, at) === './' && !dotted(hit[0])) return word;
      if (!hit || hit[0] === hit[1]) return word;
      log(hit[0], hit[1], text.slice(0, at).split('\n').length);
      return hit[1] + word.slice(hit[0].length);
    });
    return plain.replace(ESCAPED, (word, at) => {
      const hit = find(word.replaceAll('\\/', '/'));
      if (!hit) return word;
      log(hit[0], hit[1], plain.slice(0, at).split('\n').length);
      return hit[1].replaceAll('/', '\\/');
    });
  };
}

/** Resolve a relative specifier from a file to a tracked file, with the style it was written in. */
function resolveSpecifier(tracked, fromFile, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (tracked.has(target)) return { file: target, style: 'full' };
  if (tracked.has(`${target}.js`)) return { file: `${target}.js`, style: 'bare' };
  if (tracked.has(`${target}/index.js`)) return { file: `${target}/index.js`, style: 'folder' };
  return null;
}

/** Write a specifier for `file` as seen from `fromDir`, in the style the source used. */
function specifierFor(fromDir, file, style) {
  let shown = file;
  if (style === 'bare' && file.endsWith('.js')) shown = file.slice(0, -3);
  if (style === 'folder' && file.endsWith('/index.js')) shown = file.slice(0, -9);
  const relative = posix.relative(fromDir, shown) || '.';
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Rewrite every static import, re-export, dynamic import, require and new URL specifier of one file.
 *
 * @returns {{ text: string, changed: number, unresolved: string[], skipped: number, folderSpecifiers: string[] }}
 */
function rewriteSpecifiers(text, fromFile, toFile, tracked, destination, folders) {
  let changed = 0, skipped = 0;
  const unresolved = [], folderSpecifiers = [];
  const toDir = posix.dirname(toFile);
  let result = text.replace(LITERAL, (match, quote, specifier, at) => {
    if (SPECIFIER_CONTEXT.test(text.slice(Math.max(0, at - 40), at))) return match;
    const found = resolveSpecifier(tracked, fromFile, specifier);
    if (!found || found.style !== 'full') return match;
    const next = specifierFor(toDir, destination(found.file), 'full');
    if (next === specifier) return match;
    changed += 1;
    return `${quote}${next}${quote}`;
  });
  for (const pattern of SPECIFIERS) {
    result = result.replace(pattern, (match, head, quote, specifier) => {
      if (!(specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..')) return match;
      const found = resolveSpecifier(tracked, fromFile, specifier);
      if (!found) {
        const folder = posix.normalize(posix.join(posix.dirname(fromFile), specifier)).replace(/\/$/u, '');
        if (folders.dirs.has(folder)) {
          const next = posix.relative(toDir, folders.dirs.get(folder)) || '.';
          const shown = (next.startsWith('.') ? next : `./${next}`) + (specifier.endsWith('/') ? '/' : '');
          if (shown !== specifier) { changed += 1; return `${head}${quote}${shown}${quote}`; }
        } else if (folders.all.has(folder)) folderSpecifiers.push(`${fromFile}: ${specifier}`);
        skipped += 1;
        return match;
      }
      const next = specifierFor(toDir, destination(found.file), found.style);
      const back = posix.normalize(posix.join(toDir, next));
      const aimed = destination(found.file);
      if (![aimed, aimed.replace(/\.js$/u, ''), aimed.replace(/\/index\.js$/u, '')].includes(back)) unresolved.push(`${toFile}: ${specifier} became ${next}`);
      if (next === specifier) return match;
      changed += 1;
      return `${head}${quote}${next}${quote}`;
    });
  }
  return { text: result, changed, unresolved, skipped, folderSpecifiers };
}

/** Whether the bytes are text we may rewrite. */
function isText(path, buffer) { return TEXT_EXTENSION.test(path) && !buffer.includes(0); }

/** The names a module exports, following `export *` through the new tree. */
function exportsOf(file, contents, memo = new Map(), stack = new Set()) {
  if (memo.has(file)) return memo.get(file);
  const text = contents.get(file);
  if (text === undefined || stack.has(file)) return null;
  stack.add(file);
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/gmu)) names.add(match[1]);
  for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const part of match[1].split(',')) { const name = part.trim().split(/\s+as\s+/u).at(-1); if (name) names.add(name); }
  }
  if (/^export\s+default\b/mu.test(text)) names.add('default');
  for (const match of text.matchAll(/\bexport\s*\*\s*from\s*(['"])([^'"\n]+)\1/gu)) {
    const target = posix.normalize(posix.join(posix.dirname(file), match[2]));
    const inner = [target, `${target}.js`, `${target}/index.js`].find(path => contents.has(path));
    for (const name of (inner ? exportsOf(inner, contents, memo, stack) : null) ?? []) names.add(name);
  }
  stack.delete(file);
  memo.set(file, names);
  return names;
}

/** The cell a path belongs to, and the rest of its path. */
function cellOf(path) { const match = CELL.exec(path); return match ? { cell: match[1], rest: match[2] } : null; }

/**
 * Point imports of another cell's internal file at that cell's door when the door exports every imported symbol.
 * The light door serves logic files; the index door serves everything else.
 *
 * @returns {number} How many imports were repointed.
 */
function repointToDoors(contents, memo) {
  let count = 0;
  const light = lightReach(contents);
  const doors = new Set([...contents.keys()].filter(path => /^(?:apps|packages)\/[^/]+\/(?:index|light|browser)\.js$/u.test(path)));
  for (const [file, text] of contents) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    if (light.has(file)) continue;
    const here = cellOf(file);
    const next = text.replace(NAMED_IMPORT, (match, head, names, mid, quote, specifier) => {
      if (!specifier.startsWith('.')) return match;
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      const there = cellOf(target);
      if (!there || (here && here.cell === there.cell) || !/^src\/(?:logic|io)\//u.test(there.rest)) return match;
      const wanted = names.split(',').map(part => part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]).filter(Boolean);
      const candidates = (there.rest.startsWith('src/logic/') ? ['light.js', 'index.js'] : ['index.js']).map(door => `${there.cell}/${door}`);
      const door = candidates.find(path => doors.has(path) && wanted.every(name => exportsOf(path, contents, memo)?.has(name)));
      if (!door || door === file) return match;
      const relative = posix.relative(posix.dirname(file), door);
      count += 1;
      return `${head}{${names}}${mid}${quote}${relative.startsWith('.') ? relative : `./${relative}`}${quote}`;
    });
    if (next !== text) contents.set(file, next);
  }
  return count;
}

/** Every file a light door loads, directly or through other files: those stay on the light path and keep their deep imports. */
function lightReach(contents) {
  const seen = new Set(), queue = [...contents.keys()].filter(path => /^(?:apps|packages)\/[^/]+\/light\.js$/u.test(path));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !contents.has(file)) continue;
    seen.add(file);
    for (const pattern of SPECIFIERS.slice(0, 2)) {
      for (const match of contents.get(file).matchAll(pattern)) {
        if (!match[3].startsWith('.')) continue;
        const target = posix.normalize(posix.join(posix.dirname(file), match[3]));
        const next = [target, `${target}.js`, `${target}/index.js`].find(path => contents.has(path));
        if (next) queue.push(next);
      }
    }
  }
  return seen;
}

/** Statements `import ... from '...'` at the top of a module, with where they sit. */
function importStatements(text) {
  return [...text.matchAll(/^import\s+(?:[^'";]*?\sfrom\s*)?(['"])([^'"\n]+)\1[^\n]*\n/gmu)].map(match => ({ text: match[0], source: match[2], at: match.index }));
}

/** The local names an import statement binds. */
function boundNames(statement) {
  const head = /^import\s+([^'"]*?)\s*from/su.exec(statement)?.[1] ?? '';
  const names = [];
  for (const part of head.replace(/[{}]/gu, ',').split(',')) {
    const name = part.trim().split(/\s+as\s+/u).at(-1).replace(/^\*\s+as\s+/u, '').trim();
    if (name) names.push(name);
  }
  return names;
}

/** Top-level declared names of a module body. */
function declaredNames(text) {
  return [...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/gmu)].map(match => match[1]);
}

/**
 * Join tail test files into their target, keeping every case.
 * Imports are shared, a tail's helpers that clash with the target's are renamed, and the tail's input tags ride along.
 *
 * @returns {{ text: string, conflicts: string[], notes: string[] }}
 */
export function joinModules(targetText, tails) {
  const conflicts = [], notes = [];
  let text = targetText;
  const taken = new Set(declaredNames(text));
  const bound = new Map();
  for (const statement of importStatements(text)) for (const name of boundNames(statement.text)) bound.set(name, statement.source);
  let body = '';
  tails.forEach(({ old, text: tail }, index) => {
    let rest = tail;
    for (const tag of tail.matchAll(/@pullboard-test-input[^\n*]*/gu)) if (!text.includes(tag[0]) && text.trimStart().startsWith('/**')) text = text.replace(/\*\//u, ` * ${tag[0].trim()}\n */`);
    const header = /^\s*(?:\/\*\*[\s\S]*?\*\/|\/\/[^\n]*)\s*/u.exec(rest);
    if (header) rest = rest.slice(header[0].length);
    const added = [];
    const imports = importStatements(rest);
    for (const statement of imports.reverse()) {
      rest = rest.slice(0, statement.at) + rest.slice(statement.at + statement.text.length);
      const names = boundNames(statement.text);
      const named = /^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2([^\n]*)\n$/u.exec(statement.text);
      if (named) {
        const local = part => part.split(/\s+as\s+/u).at(-1);
        const parts = named[1].split(',').map(part => part.trim()).filter(Boolean);
        for (const part of parts) {
          if (bound.has(local(part)) && bound.get(local(part)) !== statement.source) notes.push(`${old}: ${local(part)} was imported from ${statement.source} and from ${bound.get(local(part))}; the first import is kept`);
        }
        const keep = parts.filter(part => !bound.has(local(part)));
        if (keep.length === parts.length) added.unshift(statement.text);
        else if (keep.length) added.unshift(`import { ${keep.join(', ')} } from ${named[2]}${named[3]}${named[2]}${named[4]}\n`);
        for (const part of keep) bound.set(local(part), statement.source);
        continue;
      }
      const clash = names.find(name => bound.has(name) && bound.get(name) !== statement.source);
      if (clash) conflicts.push(`${old}: ${clash} is imported from two places`);
      else if (names.length ? names.some(name => !bound.has(name)) : !text.includes(statement.text)) added.unshift(statement.text);
      for (const name of names) bound.set(name, statement.source);
    }
    const suffix = `Part${index + 2}`;
    for (const name of declaredNames(rest)) {
      if (!taken.has(name)) continue;
      rest = rest.replace(new RegExp(`(?<![.\\w$])${name.replaceAll('$', '\\$')}(?![\\w$])`, 'gu'), `${name}${suffix}`);
    }
    for (const name of declaredNames(rest)) taken.add(name);
    const last = importStatements(text).at(-1);
    const at = last ? last.at + last.text.length : 0;
    text = text.slice(0, at) + added.join('') + text.slice(at);
    body += `\n${rest.trim()}\n`;
  });
  return { text: `${text.trimEnd()}\n${body}`, conflicts, notes };
}

/** Rewrite one JSON value: keys and string values through `mapString`; merge keys that collide. */
function mapJson(value, mapString, options) {
  if (typeof value === 'string') return mapString(value);
  if (Array.isArray(value)) {
    const mapped = value.map(item => mapJson(item, mapString, options));
    const original = new Set(value.map(item => JSON.stringify(item)));
    const seen = new Set();
    return mapped.filter(item => {
      const key = JSON.stringify(item);
      if (original.size === value.length && seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const next = options.keys ? mapString(key) : key;
      const mapped = mapJson(item, mapString, options);
      if (!Object.hasOwn(out, next)) out[next] = mapped;
      else if (typeof mapped === 'number' && typeof out[next] === 'number') out[next] += mapped;
      else if (Array.isArray(mapped) && Array.isArray(out[next])) out[next] = [...new Set([...out[next], ...mapped])];
    }
    const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const keys = Object.keys(value);
    if (options.keys && keys.length > 1 && ordered(keys, (a, b) => a.localeCompare(b))) return sortedBy(out, (a, b) => a.localeCompare(b));
    if (options.keys && keys.length > 1 && ordered(keys, compare)) return sortedBy(out, compare);
    return out;
  }
  return value;
}

/** Whether `text` is exactly what a two-space JSON.stringify prints. */
function canonicalJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2) + '\n' === text; } catch { return false; }
}

/** Drop folder entries (`src/`, `bin`) of a list when no tracked file remains under them. */
function pruneFolders(list, remaining, wasFolder) {
  return list.filter((entry) => {
    if (typeof entry !== 'string' || entry.startsWith('!')) return true;
    const folder = entry.replace(/^\.\//u, '').replace(/\/$/u, '');
    return !wasFolder(folder) || remaining(folder);
  });
}

/** The lines of a cell lint payload as the store writes them. */
function encodeBaseline(value) {
  const readable = JSON.stringify(value, null, 2) + '\n';
  return readable.split('\n').length - 1 < 500 ? readable : JSON.stringify(value) + '\n';
}

/** Bind the cell lint baseline's hashes to the bytes now on disk: shard digests, then each cell delta's base and own hash. */
function rebindBaselines(contents, conflicts) {
  let descriptorPath = null;
  for (const [path, text] of contents) {
    if (!path.endsWith('.json')) continue;
    let value;
    try { value = JSON.parse(text); } catch { continue; }
    if (value?.version === 2 && value.metrics && Object.values(value.metrics).every(row => Array.isArray(row?.shards))) {
      for (const [metric, row] of Object.entries(value.metrics)) {
        const seen = new Set();
        for (const shard of row.shards) {
          if (!contents.has(shard.file)) continue;
          shard.sha256 = digest(contents.get(shard.file));
          for (const key of Object.keys(JSON.parse(contents.get(shard.file)).allowances ?? {})) {
            if (seen.has(key)) conflicts.push(`${metric}: ${key} is allowed in two baseline shards`);
            seen.add(key);
          }
        }
      }
      contents.set(path, JSON.stringify(value, null, 2) + '\n');
      descriptorPath = path;
    }
  }
  if (!descriptorPath) return 0;
  const base = digest(contents.get(descriptorPath));
  let rebound = 0;
  for (const [path, text] of contents) {
    if (!path.endsWith('.json') || !path.startsWith(`${dirname(descriptorPath)}/cells/`)) continue;
    const value = JSON.parse(text);
    for (const row of Object.values(value.metrics ?? {})) if (Array.isArray(row.remove)) row.remove.sort();
    const payload = { version: value.version, cell: value.cell, baseSha256: base, metrics: value.metrics };
    contents.set(path, encodeBaseline({ ...payload, sha256: digest(encodeBaseline(payload)) }));
    rebound += 1;
  }
  return rebound;
}

/**
 * Raise the cross-cell import ceilings only as far as the freeze itself adds edges (a deleted shim's importers now name the cell).
 * The cells-edges check supplies the report, so the numbers are the check's own.
 */
async function raiseEdgeCeilings(root, contents, summary) {
  const ceilingPath = [...contents.keys()].find(path => /(?:^|\/)cells-edges\.json$/u.test(path));
  const checker = ['packages/gate/src/io/edges.js', 'packages/gate/src/io/edges.js'].map(rel => join(root, rel)).find(file => disk.exists(file));
  if (!ceilingPath || !checker) return;
  const { cellsEdgeReport } = await import(pathToFileURL(checker).href);
  const ceilings = JSON.parse(contents.get(ceilingPath));
  const names = [...contents.keys()].filter(path => /\.[cm]?js$/u.test(path));
  const report = cellsEdgeReport(root, { files: names, read: file => contents.get(file) });
  for (const [file, row] of Object.entries(report.files)) {
    const have = ceilings.files[file] ?? { cells: 0, deep: 0 };
    const next = { cells: Math.max(have.cells, row.cells), deep: Math.max(have.deep, row.deep) };
    if (next.cells === have.cells && next.deep === have.deep) continue;
    ceilings.files[file] = next;
    summary.edgeCeilingsRaised.push(`${file}: cells ${have.cells} -> ${next.cells}, deep ${have.deep} -> ${next.deep}`);
  }
  for (const [name, row] of Object.entries(report.cells)) {
    const have = ceilings.cells[name] ?? { imports: [], deepImporters: 0 };
    const imports = [...new Set([...have.imports, ...row.imports])].sort();
    if (imports.length === have.imports.length && row.deepImporters <= have.deepImporters) continue;
    ceilings.cells[name] = { imports, deepImporters: Math.max(have.deepImporters, row.deepImporters) };
    summary.edgeCeilingsRaised.push(`cell ${name}: imports ${have.imports.length} -> ${imports.length}`);
  }
  if (summary.edgeCeilingsRaised.length) {
    ceilings.files = Object.fromEntries(Object.entries(ceilings.files).sort(([a], [b]) => a.localeCompare(b)));
    contents.set(ceilingPath, JSON.stringify(ceilings, null, 2) + '\n');
  }
}

/** Add the empty per-cell baseline shard that the new path-map shard needs. */
function emptyCellShard(contents, descriptorPath, name) {
  const path = `${dirname(descriptorPath)}/cells/${storeName(name)}`;
  if (contents.has(path)) return;
  const payload = { version: 1, cell: name, baseSha256: digest(contents.get(descriptorPath)), metrics: {} };
  contents.set(path, encodeBaseline({ ...payload, sha256: digest(encodeBaseline(payload)) }));
}

/**
 * Apply (or, with dryRun, only describe) the rename table.
 *
 * @param {string} root A clean Git checkout.
 * @param {{ table?: string, dryRun?: boolean, scan?: string[] }} [options]
 * @returns {object} The summary: counts and the lists the landing report needs.
 */
export async function freeze(root, { table, dryRun = false, scan = [] } = {}) {
  const status = tryGit(root, ['status', '--porcelain']);
  if (status.status !== 0 || status.stdout) throw refuse('FREEZE_DIRTY', 'the freeze needs a clean tree', 'commit or remove every change, then run it again');
  const tablePath = table ?? TABLES.map(rel => join(root, rel)).find(file => disk.exists(file));
  if (!tablePath || !disk.exists(tablePath)) throw refuse('FREEZE_NO_TABLE', 'no rename table found', 'pass --table <renames.tsv>');
  const tableText = disk.readFile(tablePath, 'utf8');
  const rows = parseTable(tableText);
  const listed = new Set(tableText.split('\n').map(line => line.split('\t')[0]));
  const files = trackedFiles(root);
  const tracked = new Set(files);
  const { moves, merges, deletes, done, missing } = planRows(tracked, rows);
  const summary = { dryRun, rows: rows.length, done, missing, moved: moves.size, merged: merges.size, deleted: deletes.size,
    importsRewritten: 0, doorRepoints: 0, pathStringsRewritten: 0, unresolved: [], conflicts: [], docLines: [], docEdits: 0,
    literalsInTests: 0, specifiersNotFiles: 0, notes: [], folderSpecifiers: [], splitFolders: [], unmapped: files.filter(file => !listed.has(file)), edgeCeilingsRaised: [], splitFolderRefs: [], segmentBuilt: [], outOfScope: [], filesChanged: 0, baselineShardsRebound: 0, pathMapShard: null };
  if (!moves.size && !merges.size && !deletes.size) return summary;
  const where = (old) => deletes.get(old) ?? merges.get(old) ?? moves.get(old) ?? old;
  const filePaths = new Map([...moves, ...merges, ...deletes]);
  const dirs = directoryMoves(tracked, moves, summary.splitFolders);
  const allFolders = new Set(files.flatMap((file) => { const out = []; for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) out.push(dir); return out; }));
  const rewrite = pathRewriter(filePaths, dirs);
  const survivors = new Set(files.filter(file => !merges.has(file) && !deletes.has(file)).map(where));
  const contents = new Map();
  const tails = new Map(), originals = new Map();
  for (const file of files) {
    if (deletes.has(file)) continue;
    const buffer = disk.readFile(join(root, file), null);
    const target = where(file);
    if (!isText(file, buffer)) continue;
    let text = buffer.toString('utf8');
    const original = text;
    originals.set(target, original);
    if (/\.(?:m?js|cjs)$/u.test(file)) {
      const result = rewriteSpecifiers(text, file, target, tracked, where, { dirs, all: allFolders });
      text = result.text;
      summary.importsRewritten += result.changed;
      summary.specifiersNotFiles += result.skipped;
      for (const line of result.folderSpecifiers) summary.folderSpecifiers.push(line);
      for (const line of result.unresolved) summary.unresolved.push(line);
      if (!MOVE_TOOL_TEST.test(file) && !HISTORY.test(file)) {
        let edits = 0;
        text = rewrite(text, () => { edits += 1; }, { segments: true, dotted: word => !resolveSpecifier(tracked, file, `./${word}`) });
        summary.pathStringsRewritten += edits;
      } else summary.literalsInTests += 1;
    } else if (!HISTORY.test(file) && !NEVER_REWRITE.test(file) && !/\.tsv$/u.test(file)) {
      const listed = DOC_LISTED.has(file);
      const log = (from, to, line) => { summary.docEdits += 1; if (listed) summary.docLines.push(`${file}:${line}: ${from} -> ${to}`); };
      if (file.endsWith('.json')) {
        if (canonicalJson(text)) {
          let edits = 0;
          const mapString = value => rewrite(value, () => { edits += 1; });
          text = JSON.stringify(mapJson(JSON.parse(text), mapString, { keys: !PATH_MAP_SHARD.test(file) }), null, 2) + '\n';
          summary.pathStringsRewritten += edits;
        } else { let edits = 0; text = rewrite(text, () => { edits += 1; }); summary.pathStringsRewritten += edits; }
      } else if (file.endsWith('.md') && !DOCS.test(file)) text = original;
      else text = rewrite(text, log);
    }
    if (merges.has(file)) tails.set(file, { target, text });
    else contents.set(target, text);
  }
  const groups = new Map();
  for (const [old, { target, text }] of tails) groups.set(target, [...(groups.get(target) ?? []), { old, text }]);
  for (const [target, list] of groups) {
    if (!contents.has(target)) { summary.conflicts.push(`merge target ${target} does not exist`); continue; }
    const joined = joinModules(contents.get(target), list.sort((a, b) => a.old.localeCompare(b.old)));
    contents.set(target, joined.text);
    for (const line of joined.conflicts) summary.conflicts.push(line);
    for (const line of joined.notes) summary.notes.push(line);
  }
  const jsOnly = new Map([...contents].filter(([path]) => /\.(?:m?js)$/u.test(path)));
  const doorMemo = new Map();
  summary.doorRepoints = repointToDoors(jsOnly, doorMemo);
  for (const [path, text] of jsOnly) contents.set(path, text);
  for (const [path, text] of contents) {
    if (path === 'package.json') {
      const value = JSON.parse(text);
      const remaining = folder => [...survivors].some(file => file.startsWith(`${folder}/`));
      if (Array.isArray(value.files)) value.files = pruneFolders(value.files, remaining, folder => files.some(file => file.startsWith(`${folder}/`)));
      if (Array.isArray(value.files) && hasFolder(survivors, 'apps') && !value.files.includes('!*/*/journeys/**')) value.files.push('!*/*/journeys/**');
      contents.set(path, JSON.stringify(value, null, 2) + '\n');
    } else if (path === 'pullboard.json') {
      const value = JSON.parse(text);
      const remaining = folder => [...survivors].some(file => file.startsWith(`${folder}/`));
      const wasFolder = folder => files.some(file => file.startsWith(`${folder}/`));
      for (const lane of Object.values(value.lanes ?? {})) if (Array.isArray(lane.owns)) lane.owns = pruneFolders(lane.owns, remaining, wasFolder);
      contents.set(path, JSON.stringify(value, null, 2) + '\n');
    }
  }
  const shard = [...survivors].find(path => PATH_MAP_SHARD.test(path));
  const shardDir = shard ? dirname(shard) : 'packages/codemap/data/plan/plan/path-map';
  const shardPath = `${shardDir}/freeze.json`;
  if (!contents.has(shardPath)) {
    const known = new Set();
    for (const [path, text] of contents) if (PATH_MAP_SHARD.test(path)) for (const key of Object.keys(JSON.parse(text))) known.add(key);
    const map = {};
    for (const [old, to] of [...moves, ...merges].sort(([a], [b]) => (a < b ? -1 : 1))) if (!known.has(old) && old !== to) map[old] = to;
    contents.set(shardPath, JSON.stringify(map, null, 2) + '\n');
    summary.pathMapShard = shardPath;
    const descriptor = [...contents.keys()].find(path => /index\.json$/u.test(path) && contents.get(path).includes('"shards"'));
    if (descriptor) emptyCellShard(contents, descriptor, 'freeze');
  }
  await raiseEdgeCeilings(root, contents, summary);
  summary.baselineShardsRebound = rebindBaselines(contents, summary.conflicts);
  for (const [path, text] of contents) {
    if (/\.(?:m?js|cjs)$/u.test(path)) {
      for (const [at, line] of text.split('\n').entries()) if (/['"`](?:bin|src|test|relay)['"`]\s*[,)]/u.test(line) && /\b(?:join|resolve)\(/u.test(line)) summary.segmentBuilt.push(`${path}:${at + 1}`);
    }
    if (path.endsWith('.json')) {
      try {
        const walk = (value) => {
          if (typeof value === 'string') {
            const folder = /^(?:\.\/)?([\w@.-]+(?:\/[\w@.-]+)*)\/(?:\*.*)?$/u.exec(value)?.[1];
            if (folder && files.some(file => file.startsWith(`${folder}/`)) && !survivors.has(folder) && ![...survivors].some(file => file.startsWith(`${folder}/`))) summary.splitFolderRefs.push(`${path}: ${value}`);
          } else if (Array.isArray(value)) value.forEach(walk);
          else if (value && typeof value === 'object') Object.values(value).forEach(walk);
        };
        if (!PATH_MAP_SHARD.test(path)) walk(JSON.parse(text));
      } catch { /* not a JSON document we rewrite */ }
    }
  }
  for (const folder of scan) for (const line of scanOutside(folder, filePaths)) summary.outOfScope.push(line);
  summary.filesChanged = [...contents].filter(([path, text]) => originals.get(path) !== text).length;
  if (dryRun) return summary;
  applyChanges({ root, moves, merges, deletes, contents });
  return summary;
}

/** Whether any surviving path starts with a folder. */
function hasFolder(paths, folder) { return [...paths].some(path => path.startsWith(`${folder}/`)); }

/** Paths from outside the repository (seat wrappers and the like) that name moved files; listed, never changed. */
function scanOutside(folder, filePaths) {
  const found = [];
  const rewrite = pathRewriter(filePaths, new Map());
  const walk = (dir, depth) => {
    for (const name of disk.list(dir)) {
      const path = join(dir, name);
      let stat;
      try { stat = disk.stat(path); } catch { continue; }
      if (stat.isDirectory()) { if (depth < 3 && !/^(?:node_modules|\.git|worktrees|logs?)$/u.test(name)) walk(path, depth + 1); continue; }
      if (stat.size > 300_000 || !/\.(?:sh|zsh|bash|md|txt|plist|json|js|mjs|toml|yml|yaml)$/u.test(name)) continue;
      const buffer = disk.readFile(path, null);
      if (buffer.includes(0)) continue;
      let first = null, count = 0;
      rewrite(buffer.toString('utf8'), (from, to, line) => { count += 1; first ??= `${line}: ${from} -> ${to}`; });
      if (count) found.push(`${path}: ${count} paths, first at ${first}`);
    }
  };
  if (disk.exists(folder)) walk(folder, 0);
  return found;
}

/** Do the work on disk: git mv every row, join, delete, then write and stage every rewritten file. */
function applyChanges({ root, moves, merges, deletes, contents }) {
  let pending = [...moves];
  while (pending.length) {
    const blocked = [];
    for (const [old, to] of pending) {
      if (disk.exists(join(root, to))) { blocked.push([old, to]); continue; }
      disk.mkdir(join(root, dirname(to)), { recursive: true });
      const moved = tryGit(root, ['mv', '--', old, to]);
      if (moved.status !== 0) throw refuse('FREEZE_MOVE', `git mv ${old} ${to} failed: ${moved.stderr}`, 'fix the row and run the freeze again on a clean tree');
    }
    if (blocked.length === pending.length) throw refuse('FREEZE_CYCLE', `${blocked[0][1]} is occupied by a file that does not move`, 'correct the rename table');
    pending = blocked;
  }
  for (const old of [...deletes.keys(), ...merges.keys()]) {
    const gone = tryGit(root, ['rm', '-q', '-f', '--', old]);
    if (gone.status !== 0) throw refuse('FREEZE_DELETE', `git rm ${old} failed: ${gone.stderr}`, 'fix the row and run the freeze again on a clean tree');
  }
  for (const old of [...moves.keys(), ...merges.keys(), ...deletes.keys()]) {
    for (let dir = dirname(old); dir !== '.' && disk.exists(join(root, dir)) && !disk.list(join(root, dir)).length; dir = dirname(dir)) disk.rm(join(root, dir), { recursive: true });
  }
  const written = [];
  for (const [path, text] of contents) {
    const file = join(root, path);
    const before = disk.exists(file) ? disk.readFile(file, null).toString('utf8') : null;
    if (before === text) continue;
    disk.mkdir(dirname(file), { recursive: true });
    disk.writeFile(file, text);
    written.push(path);
  }
  for (let at = 0; at < written.length; at += 200) tryGit(root, ['add', '--', ...written.slice(at, at + 200)]);
}

/** Read the command line and run the freeze. */
async function main(argv) {
  const options = { scan: [] };
  let root = process.cwd();
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--root') root = resolve(argv[++at]);
    else if (arg === '--table') options.table = resolve(argv[++at]);
    else if (arg === '--scan') options.scan.push(resolve(argv[++at]));
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else throw refuse('FREEZE_USAGE', `unknown argument ${arg}`, 'use --root, --table, --scan, --dry-run or --json');
  }
  const summary = await freeze(root, options);
  if (options.json) { process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`); return; }
  const lines = [`${summary.dryRun ? 'dry run' : 'freeze'}: ${summary.rows} rows, ${summary.done} already done, ${summary.missing.length} missing`,
    `moved ${summary.moved}, merged ${summary.merged}, deleted ${summary.deleted}, files rewritten ${summary.filesChanged}`,
    `imports rewritten ${summary.importsRewritten}, repointed to doors ${summary.doorRepoints}, path strings rewritten ${summary.pathStringsRewritten}, doc lines ${summary.docEdits}`,
    `unresolved imports ${summary.unresolved.length}, merge conflicts ${summary.conflicts.length}, rows without a file ${summary.missing.length}, files without a row ${summary.unmapped.length}`];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
