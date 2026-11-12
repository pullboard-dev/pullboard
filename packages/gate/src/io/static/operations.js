/** The operation registry (doctrine CD2, single path): one entry point per machine operation, and a lint that refuses a second one [C7]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { gitSpawnSync } from '../../../../git/index.js';
import { lex } from '../scan.js';
import { lineAt } from '../scan.js';
import { readText } from '../scan.js';
import { report } from '../scan.js';
import { walk } from '../scan.js';

export const OPERATION_ENTRIES_BASELINE = 'packages/gate/data/baselines/operation-entries.json';
const BASELINE_URL = new URL('../../../data/baselines/operation-entries.json', import.meta.url);
/** Shipped source files: each app's and package's src/ and bin/ trees, never tests or fixtures. */
const SOURCE = /^(?:apps|packages)\/[^/]+\/(?:src|bin)\/(?:.*\/)?[^/]+\.[cm]?js$/u;
const CHILD = /(?<![\w$.])(?:spawnSync|execFileSync|execFile|execSync|spawn|fork)\s*\(/u;
const TEST_RUNNER = /run-tests\.js|['"`]--test['"`]/u;

/**
 * The one list of operations and the file that is each one's single entry point. `marks` finds the line in a file's
 * code (comments removed, strings kept) that makes that file an entry point of the operation. Why: Corey 11 Nov,
 * single path; every other file that marks an operation is a second path, named in the baseline so it may only go.
 */
export const OPERATIONS = Object.freeze([
  { name: 'run-tests', entry: 'packages/gate/src/io/run-tests.js', why: 'spawns the test runner',
    marks: code => (TEST_RUNNER.test(code) ? code.search(CHILD) : -1) },
  { name: 'dispatch-gates', entry: 'apps/cli/src/io/submit/pull.js', why: 'defines a gate dispatch',
    marks: code => code.search(/export\s+(?:async\s+)?function\s+(?:run|offer|dispatch|start)\w*Gate\w*\s*\(/u) },
  { name: 'landing', entry: 'packages/api/src/io/landing.js', why: 'defines a landing',
    marks: code => code.search(/export\s+(?:async\s+)?function\s+(?:land|land[A-Z]\w*|offerLanding\w*|runLanding\w*)\s*\(/u) },
  { name: 'record-proof', entry: 'packages/store/src/io/receipts.js', why: 'defines a proof or clause-tick writer',
    marks: code => code.search(/export\s+(?:async\s+)?function\s+record\w*(?:Ticks?|Proof|ProofRun)\s*\(/u) },
  { name: 'start-daemons', entry: 'packages/jobs/src/io/launch.js', why: 'starts a detached process',
    marks: code => code.search(/\bdetached\s*:\s*true\b/u) },
  { name: 'fetch-runner-code', entry: 'apps/runner/src/io/worker/checkout.js', why: 'runs a git fetch',
    marks: code => code.search(/[[,]\s*['"`]fetch['"`]/u) },
]);

/** The source with its comments blanked and its strings kept, so a commented-out call is not a site. */
function withoutComments(source) {
  let code = source;
  for (const { start, end } of lex(source).comments) code = code.slice(0, start) + code.slice(start, end).replace(/[^\n]/gu, ' ') + code.slice(end);
  return code;
}

/**
 * The operation entry points one source file holds, other than each operation's registered entry.
 *
 * @param {string} source - File text.
 * @param {string} path - Repo-relative path; only shipped src/ and bin/ files have sites.
 * @returns {{ path: string, line: number, operation: string, text: string }[]}
 */
export function operationSites(source, path) {
  if (!SOURCE.test(path)) return [];
  const code = withoutComments(source);
  return OPERATIONS.flatMap(({ name, entry, why, marks }) => {
    if (path === entry) return [];
    const at = marks(code);
    return at < 0 ? [] : [{ path, line: lineAt(source, at), operation: name, text: `${why} outside ${entry}, the one ${name} entry point; call it instead [C7]` }];
  });
}

/** Every operation site in a checkout's shipped source. */
export function operationReport(root) {
  return walk(root, SOURCE).flatMap(path => operationSites(readText(root, path), path));
}

/** Files per operation, other than its entry, as the baseline records them: `{ operation: [path, ...] }`. */
export function operationEntryFiles(sites) {
  const files = Object.fromEntries(OPERATIONS.map(({ name }) => [name, []]));
  for (const { operation, path } of sites) if (!files[operation].includes(path)) files[operation].push(path);
  for (const name of Object.keys(files)) files[name].sort();
  return files;
}

/** The count of entry points per operation: the registered entry plus each second path the baseline still allows. */
export function operationEntryCounts(baseline) {
  return Object.fromEntries(OPERATIONS.map(({ name }) => [name, 1 + (baseline[name] ?? []).length]));
}

/** Sites that are a second entry point the baseline does not allow; a new file, or a new operation in a known file. */
export function operationEntryGrowth(sites, baseline) {
  return sites.filter(site => !(baseline[site.operation] ?? []).includes(site.path));
}

/**
 * Baseline rows that raise an operation's entry-point count over accepted main's: the count may only fall.
 *
 * @param {Record<string, string[]>} baseline - This tree's baseline.
 * @param {Record<string, string[]> | null} accepted - Main's baseline; none means nothing to compare.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function operationRatchetGrowth(baseline, accepted) {
  if (!accepted) return [];
  return Object.entries(baseline).flatMap(([name, files]) => files.filter(file => !(accepted[name] ?? []).includes(file))
    .map(file => ({ path: OPERATION_ENTRIES_BASELINE, line: 1, text: `${name} gains a second entry point ${file}; the entry-point count may only fall [C7]` })));
}

/** The updater only lowers the baseline: it refuses before writing when any second entry point is new. */
export function tightenOperationBaseline(sites, baseline) {
  const growth = operationEntryGrowth(sites, baseline);
  if (growth.length) throw new Error(growth.map(row => `${row.path}:${row.line}: ${row.text}`).join('\n'));
  return operationEntryFiles(sites);
}

/** Main's baseline, or null when main has none (a project that is not this repository). */
function mainBaseline(root) {
  const shown = gitSpawnSync(['show', `refs/heads/main:${OPERATION_ENTRIES_BASELINE}`], { cwd: root, encoding: 'utf8' });
  return shown.status === 0 ? JSON.parse(shown.stdout) : null;
}

/**
 * The whole-tree check: new second entry points, and baseline rows main did not allow.
 *
 * @param {string} root - Checkout root.
 * @returns {string[]} One `path:line: message` per failure.
 */
export function operationEntryProblems(root) {
  let baseline;
  try { baseline = JSON.parse(readFileSync(resolve(root, OPERATION_ENTRIES_BASELINE), 'utf8')); } catch { return []; } // a project without the baseline has nothing to judge
  return [...operationEntryGrowth(operationReport(root), baseline), ...operationRatchetGrowth(baseline, mainBaseline(root))]
    .map(row => `${row.path}:${row.line}: ${row.text}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.cwd());
  const sites = operationReport(root);
  if (process.argv.includes('--report')) console.log(JSON.stringify(operationEntryFiles(sites), null, 2));
  else if (process.argv.includes('--write')) writeFileSync(BASELINE_URL, JSON.stringify(operationEntryFiles(sites), null, 2) + '\n'); // first record only
  else {
    const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
    if (process.argv.includes('--ratchet')) writeFileSync(BASELINE_URL, JSON.stringify(tightenOperationBaseline(sites, baseline), null, 2) + '\n');
    else report(operationEntryGrowth(sites, baseline));
  }
}
