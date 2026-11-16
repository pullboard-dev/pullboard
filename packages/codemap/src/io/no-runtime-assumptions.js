/**
 * Doctrine check: core code names no test runner or operating system [C7].
 *
 * Pullboard must work for other users' setups and languages, so a literal `.test.js`, `node --test`, `/bin/sh` or
 * `darwin` belongs only in an adapter. This check reads every source file outside the adapter paths listed in
 * no-runtime-assumptions.json and counts those four literals per file (comments are blanked first). Today's
 * occurrences are listed per file in the same file's baseline, which may only fall: a file with more of a kind than
 * its baseline allows (an unlisted file allows none) is refused, naming each site. Test files judge nothing: a test
 * names its runner by being a test.
 *
 * @file-local Reads the config and the sources under the root, through `read` when a caller supplies one.
 */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lex } from '../../../kernel/index.js';
import { lineAt } from '../../../kernel/index.js';
import { TEST_FILE } from './check-walk.js';
import { readText } from './check-walk.js';
import { walk } from './check-walk.js';

const CONFIG = 'packages/gate/data/ceilings/no-runtime-assumptions.json';
const SOURCE = /\.[cm]?js$/u;

/** The four literals a core file must not name, each with the words the refusal uses. */
const ASSUMPTIONS = Object.freeze({
  testFile: { pattern: /\.test\\?\.|\.test\.\[cm\]/gu, name: 'a .test.js file name' },
  nodeTest: { pattern: /node\s+--test\b|['"]--test['"]/gu, name: 'node --test' },
  binSh: { pattern: /\/bin\/sh\b/gu, name: '/bin/sh' },
  darwin: { pattern: /['"]darwin['"]/gu, name: 'a darwin check' },
});

/**
 * The config file's adapter paths and baseline, or an empty config when the tree has none.
 *
 * @param {(path: string) => string} read
 * @returns {{ adapters: string[], baseline: Record<string, Record<string, number>> }}
 */
function assumptionConfig(read) {
  let text;
  try { text = read(CONFIG); } catch { return { adapters: [], baseline: {} }; } // a tree without the file judges nothing
  const parsed = JSON.parse(text || '{}');
  return { adapters: parsed.adapters ?? [], baseline: parsed.baseline ?? {} };
}

/**
 * Whether a path is judged: a source file that is neither a test, nor this check, nor under an adapter path.
 *
 * @param {string} file - repo-relative path
 * @param {string[]} adapters - adapter files, or directory prefixes ending in `/`
 * @returns {boolean}
 */
function judged(file, adapters) {
  if (!SOURCE.test(file) || TEST_FILE.test(file)) return false;
  if (/(?:^|\/)tests?\//u.test(file) || file.startsWith('packages/gate/src/io/assumptions') || file === 'packages/codemap/src/io/no-runtime-assumptions.js') return false;
  return !adapters.some(path => (path.endsWith('/') ? file.startsWith(path) : file === path));
}

/**
 * Each assumption literal in a source, with its kind and line; comments do not count.
 *
 * @param {string} source
 * @returns {{ kind: string, line: number }[]}
 */
export function assumptionsIn(source) {
  const blanked = source.split('');
  for (const { start, end } of lex(source).comments) for (let at = start; at < end; at += 1) if (blanked[at] !== '\n') blanked[at] = ' ';
  const text = blanked.join('');
  const found = [];
  for (const [kind, { pattern }] of Object.entries(ASSUMPTIONS)) {
    for (const match of text.matchAll(pattern)) found.push({ kind, line: lineAt(source, match.index) });
  }
  return found;
}

/**
 * Assumption sites per judged file.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (path: string) => string }} [options]
 * @returns {Record<string, { kind: string, line: number }[]>}
 */
function assumptionReport(root, { files = walk(root, SOURCE), read = path => readText(root, path) } = {}) {
  const { adapters } = assumptionConfig(read);
  const out = {};
  for (const file of files) {
    if (!judged(file, adapters)) continue;
    let source;
    try { source = read(file); } catch { continue; } // a file deleted in a staged tree has nothing to judge
    const sites = assumptionsIn(source);
    if (sites.length) out[file] = sites;
  }
  return out;
}

/**
 * One problem per site of each kind a file names more often than its baseline allows.
 *
 * @param {string} root
 * @param {{ files?: string[], only?: string[], read?: (path: string) => string }} [options] only: the changed files to judge instead of the tree
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function assumptionProblems(root, options = {}) {
  const read = options.read ?? (path => readText(root, path));
  const { baseline } = assumptionConfig(read);
  const problems = [];
  // A commit or submit passes its changed files: a file's problems depend on its own text and the config alone, so an
  // unchanged file keeps main's clean result and the whole tree is read only when the config itself changed (the gate still judges the whole tree) [#8152].
  const scoped = options.only && !options.only.includes(CONFIG) ? { files: options.only } : {};
  for (const [path, sites] of Object.entries(assumptionReport(root, { ...options, ...scoped, read }))) {
    for (const [kind, { name }] of Object.entries(ASSUMPTIONS)) {
      const own = sites.filter(site => site.kind === kind);
      const allowed = baseline[path]?.[kind] ?? 0;
      if (own.length <= allowed) continue;
      for (const site of own) {
        problems.push({ path, line: site.line, text: `core code names ${name}: ${own.length} sites exceed the baseline ${allowed}; move it into an adapter listed in ${CONFIG}, or lower the baseline only by removing sites` });
      }
    }
  }
  return problems;
}

/**
 * Write the baseline to today's counts: a file listed there falls to what it names now, and an unlisted file is
 * never added, so growth is not written.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]} the growth problems left unwritten
 */
export function writeAssumptionBaseline(root) {
  const file = join(root, CONFIG);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const today = assumptionReport(root);
  const lowered = {};
  for (const [path, kinds] of Object.entries(config.baseline)) {
    const row = {};
    for (const [kind, allowed] of Object.entries(kinds)) {
      const actual = (today[path] ?? []).filter(site => site.kind === kind).length;
      if (actual > 0) row[kind] = Math.min(allowed, actual);
    }
    if (Object.keys(row).length) lowered[path] = row;
  }
  writeFileSync(file, `${JSON.stringify({ ...config, baseline: lowered }, null, 2)}\n`);
  return assumptionProblems(root);
}

/**
 * Today's per-file counts, for seeding the baseline once.
 *
 * @param {string} root
 * @returns {Record<string, Record<string, number>>}
 */
export function assumptionCounts(root) {
  const counts = {};
  for (const [path, sites] of Object.entries(assumptionReport(root))) {
    counts[path] = {};
    for (const { kind } of sites) counts[path][kind] = (counts[path][kind] ?? 0) + 1;
  }
  return counts;
}
