/**
 * Rigor check: no synchronous child process inside leased work [C7].
 *
 * A leased job, driver or producer renews its lease on a timer, and `spawnSync`, `execSync` or `execFileSync`
 * blocks the event loop until the child exits, so the timer cannot fire and the lease lapses (three lease losses on
 * 7 Nov: the gate driver, the cells-inventory producer and a blocking test cleanup). This check reads the entry
 * files named in sync-spawn-in-leases.json, follows their relative imports, and flags every call to one of the three
 * in any module reached. Existing calls are listed per file in the same file's baseline, which may only fall:
 * a file that calls more than its baseline allows (an unlisted file allows none) is refused, naming each call site.
 * Strings and comments are masked first, and an `import { spawnSync as run }` alias counts as well.
 *
 * @file-local Reads the config and the modules reached from its entries, through `read` when a caller supplies one.
 */
import { fileSystemAdapter } from '../../../fs/index.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { lex } from '../../../kernel/index.js';
import { lineAt } from '../../../kernel/index.js';
import { readText } from './check-walk.js';
import { walk } from './check-walk.js';

const CONFIG = 'packages/gate/data/ceilings/sync-spawn-in-leases.json';
const SYNC_CALLS = ['spawnSync', 'execSync', 'execFileSync'];
const SOURCE = /\.[cm]?js$/u;

/**
 * The config file's entries and baseline, or an empty config when the tree has none.
 *
 * @param {(path: string) => string} read
 * @returns {{ entries: string[], baseline: Record<string, number> }}
 */
export function syncSpawnConfig(read) {
  let text;
  try { text = read(CONFIG); } catch { return { entries: [], baseline: {} }; } // a tree without the file has no leased entries to judge
  const parsed = JSON.parse(text || '{}');
  return { entries: parsed.entries ?? [], baseline: parsed.baseline ?? {} };
}

/**
 * Every relative module a source imports, re-exports or dynamically imports, as repo-relative paths.
 *
 * @param {string} file - repo-relative path of the importing module
 * @param {string} source
 * @returns {string[]}
 */
function relativeImports(file, source) {
  const { code } = lex(source);
  const found = [];
  for (const match of source.matchAll(/\b(?:import|export)\b(?:[^;'"`]*?\bfrom\s*|\s*|\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/gu)) {
    if (code.slice(match.index, match.index + 6) !== source.slice(match.index, match.index + 6)) continue; // inside a comment or string
    found.push(join(dirname(file), match[2]).split('\\').join('/'));
  }
  return found;
}

/**
 * Each synchronous child process call in a source, with its line.
 *
 * @param {string} source
 * @returns {{ line: number, name: string }[]}
 */
export function syncCallsIn(source) {
  const { code } = lex(source);
  const names = new Set(SYNC_CALLS);
  for (const match of code.matchAll(/\b(spawnSync|execSync|execFileSync)\s+as\s+([\w$]+)/gu)) names.add(match[2]);
  const pattern = new RegExp(`(?<![\\w$])(${[...names].map(name => name.replace(/\$/gu, '\\$')).join('|')})\\s*\\(`, 'gu');
  const calls = [];
  for (const match of code.matchAll(pattern)) {
    const before = code.slice(Math.max(0, match.index - 9), match.index);
    if (/\bfunction\s+$/u.test(before)) continue; // a declaration of the same name is not a call
    calls.push({ line: lineAt(source, match.index), name: match[1] });
  }
  return calls;
}

/**
 * Every module reached from the entries, each with the entry that first reached it.
 *
 * @param {string[]} entries - repo-relative files or directory prefixes ending in `/`
 * @param {string[]} files - every source file in the tree
 * @param {(path: string) => string} read
 * @returns {Map<string, string>} reached file -> entry it was reached from
 */
export function leasedModules(entries, files, read) {
  const known = new Set(files);
  const reached = new Map();
  for (const entry of entries) {
    const roots = entry.endsWith('/') ? files.filter(file => file.startsWith(entry)) : [entry];
    const pending = roots.filter(file => known.has(file));
    for (const file of pending) if (!reached.has(file)) reached.set(file, file);
    while (pending.length) {
      const file = pending.pop();
      let source;
      try { source = read(file); } catch { continue; } // a module deleted in a staged tree has nothing to follow
      for (const next of relativeImports(file, source)) {
        if (!known.has(next) || reached.has(next)) continue;
        reached.set(next, reached.get(file));
        pending.push(next);
      }
    }
  }
  return reached;
}

/**
 * Sync calls per reached file, for the baseline and the report.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (path: string) => string }} [options]
 * @returns {Record<string, { entry: string, lines: number[] }>}
 */
export function syncSpawnReport(root, { files = walk(root, SOURCE), read = path => readText(root, path) } = {}) {
  const { entries } = syncSpawnConfig(read);
  const out = {};
  for (const [file, entry] of leasedModules(entries, files, read)) {
    let source;
    try { source = read(file); } catch { continue; } // an unreadable module cannot be judged
    const lines = syncCallsIn(source).map(call => call.line);
    if (lines.length) out[file] = { entry, lines };
  }
  return out;
}

/** Whether a file calls a synchronous child more often than its baseline allows; a file that cannot be read calls none. */
function callsOverBaseline(file, baseline, read) {
  try { return syncCallsIn(read(file)).length > (baseline[file] ?? 0); } catch { return false; }
}

/**
 * One problem per call in each reached file that calls more than its baseline allows.
 *
 * @param {string} root
 * @param {{ files?: string[], only?: string[], read?: (path: string) => string }} [options] only: the changed files to judge instead of the tree
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function syncSpawnProblems(root, options = {}) {
  const read = options.read ?? (path => readText(root, path));
  const { baseline } = syncSpawnConfig(read);
  // A commit or submit passes its changed files. A problem needs a file calling more than its baseline, so when no changed
  // file does and the config is unchanged, main's clean result stands and the import graph is never walked; the gate still walks it [#8152].
  if (options.only && !options.only.includes(CONFIG) && !options.only.some(file => SOURCE.test(file) && callsOverBaseline(file, baseline, read))) return [];
  const problems = [];
  for (const [path, { entry, lines }] of Object.entries(syncSpawnReport(root, { ...options, read }))) {
    const allowed = baseline[path] ?? 0;
    if (lines.length <= allowed) continue;
    for (const line of lines) {
      problems.push({ path, line, text: `synchronous child process in leased work (reached from ${entry}): ${lines.length} calls exceed the baseline ${allowed}; run it async so the lease timer fires, or lower the baseline only by removing calls` });
    }
  }
  return problems;
}

/**
 * Lower the baseline to today's counts where a file now calls less; growth is never written.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]} the growth problems left unwritten
 */
export function writeSyncSpawnBaseline(root) {
  const file = join(root, CONFIG);
  const config = JSON.parse(fileSystemAdapter().readFile(file, 'utf8'));
  const today = syncSpawnReport(root);
  const lowered = {};
  for (const [path, allowed] of Object.entries(config.baseline)) {
    const actual = today[path]?.lines.length ?? 0;
    if (actual > 0) lowered[path] = Math.min(allowed, actual);
  }
  fileSystemAdapter().writeFile(file, `${JSON.stringify({ ...config, baseline: lowered }, null, 2)}\n`);
  return syncSpawnProblems(root);
}
