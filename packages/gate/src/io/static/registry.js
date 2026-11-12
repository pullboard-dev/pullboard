/** The whole-tree static check classes `apps/cli/src/io/static/checks.js` runs, listed once with a runner each [C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mainCommit } from '../../../../codemap/index.js';
import { styleSources } from '../../../../codemap/index.js';
import { importStyleViolations } from '../../../index.js';
import { engineFolderViolations } from '../../../../state/index.js';
import { doctrineReport } from '../../../../doctrine/index.js';
import { loadConfig } from '../../../../config/index.js';
import { testWaitReport } from '../test/waits.js';
import { cliLaunchReport } from '../test/launches.js';
import { cliLaunchGrowth } from '../test/launches.js';
import { operationEntryProblems } from './operations.js';
import { testWaitGrowth } from '../test/waits.js';
import { boardWriteIoProblems } from '../board/write.js';
import { relayBoundaryProblems } from '../relay.js';
import { fixtureProblems } from '../test/fixtures.js';
import { fixtureSites } from '../test/fixtures.js';
import { cellsEdgeProblems } from '../edges.js';
import { fileEdges } from '../edges.js';
import { testCellsProblems } from '../test/cells.js';
import {
  fileFindings,
  missingPathFindings,
  missingPathGrowth,
  readMissingPathBaseline,
} from '../paths/lint.js';
import { STATIC_CHECKS } from '../../../index.js';
import { cliReachRows } from '../../../index.js';
import { keylessRows } from '../../../index.js';
import { repoPath } from '../../../../kernel/light.js';
import { blobOid } from './cache.js';
import { fileCache } from './cache.js';
import { toolingKey } from './cache.js';
import { cellRows } from './cache.js';
import { cellScopedKey } from './cache.js';

/** What a check reads, so a change to none of those paths keeps main's answer [5814]: JavaScript sources, and test files among them. */
const SOURCE = path => /\.[cm]?js$/u.test(path);
const TEST = path => SOURCE(path) && (path.split('/').slice(0, -1).some(part => part === 'tests' || part === 'test') || /[-_.]test\.[cm]?js$/u.test(path));

/** The context a check gets when called on its own: caches that live and die inside the call. */
const MEMORY = Object.freeze({ cache: (name, version) => fileCache({ name, version, tooling: '', home: null }) });

/** Import-style violations, one source at a time: each file's rows depend on that file alone, so they are kept by blob [5564]. */
function importStyleRows(sources, cache) {
  return sources.flatMap(source => cache.get(source.file, blobOid(source.source), () => importStyleViolations([source])));
}

/** The style sources of the tree: the registry's own, read once, or a fresh read when a check is called on its own. */
const treeSources = (root, sources) => sources ?? styleSources(root);

/** The per-file import edges every cell-scoped check shares, kept by blob. */
const edgeCacheOf = context => context.cache('cell-edges', 1);

/**
 * Missing-path findings per file by blob. A file's findings also depend on which repository paths exist, so each entry keeps
 * its probes (path relative to the root, and what was found) and is reused only while every probe still answers the same.
 */
function cachedMissingPaths(root, context) {
  const cache = context.cache('missing-paths', 1), topsKeys = new WeakMap();
  const findingsOf = (at, file, source, tops) => {
    if (!topsKeys.has(tops)) topsKeys.set(tops, blobOid([...tops].sort().join(',')));
    const probesHold = entry => entry.probes.every(([path, found]) => existsSync(resolve(at, path)) === found);
    return cache.get(file, `${blobOid(source)}:${topsKeys.get(tops)}`, () => {
      const probes = [];
      const rows = fileFindings(at, file, source, tops, abs => { const found = existsSync(abs); probes.push([relative(at, abs), found]); return found; });
      return { rows, probes };
    }, probesHold).rows;
  };
  return missingPathGrowth(missingPathFindings(root, { findingsOf }), readMissingPathBaseline(root));
}

/**
 * Read the declared prose commands and the CLI catalog from the tree being checked, in a child process started in that tree.
 * The gate runs this file from a copy of main, so importing the catalog here would judge main's catalog, never the item's:
 * a catalog fix could not pass the check it fixes (#3827).
 *
 * @param {string} root - Checkout root whose apps/cli/index.js is read.
 * @returns {{declared: string[], actual: string[]}} Both lists, sorted.
 */
function proseCommandSets(root) {
  const entry = pathToFileURL(join(root, 'apps/cli/index.js')).href;
  const program = `const { HELP, declaredProseCommands, PULLBOARD_COMMANDS } = await import(${JSON.stringify(entry)});
process.stdout.write(JSON.stringify({ declared: [...declaredProseCommands(HELP)].sort(), actual: [...PULLBOARD_COMMANDS].sort() }));`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program], { cwd: root, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`prose-commands could not read the catalog of ${root}: ${child.stderr.trim()}`);
  return JSON.parse(child.stdout);
}

/** The measurement takes about a second; a minute is ample on a loaded gate and still ends a hung child [5642]. */
const WORKER_BUNDLE_TIMEOUT_MS = 60_000;

/**
 * Measure the runner worker bundle in a child process and compare it with its recorded ceiling.
 *
 * @param {string} root - Checkout root.
 * @returns {string[]} The failure, or nothing.
 */
function workerBundleRows(root) {
  // The runner worker bundle's raw size may only fall; growth fails here, never silently at a runner (#4140).
  const recorded = JSON.parse(readFileSync(join(root, 'packages/gate/data/ceilings/worker-bundle.json'), 'utf8')).bytes;
  // Each phase is written to stderr as it starts, so a measurement past its deadline names the step that hung [5642].
  const program = `const { workerBundleBytes } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/runners/index.js')).href)});\nprocess.stdout.write(String(workerBundleBytes(${JSON.stringify(root)}, undefined, step => process.stderr.write('step: ' + step + '\\n'))));`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program], { cwd: root, encoding: 'utf8', timeout: WORKER_BUNDLE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const lines = (child.stderr ?? '').trim().split('\n');
  const step = lines.filter(line => line.startsWith('step: ')).at(-1)?.slice(6) ?? 'start the measuring process';
  if (child.error?.code === 'ETIMEDOUT') return [`packages/gate/data/ceilings/worker-bundle.json:1: the runner worker bundle measurement passed ${WORKER_BUNDLE_TIMEOUT_MS / 1000} s at the step: ${step}`];
  const error = lines.find(line => /^\w*(Error|Refused)\b/u.test(line)) ?? lines.filter(line => !line.startsWith('step: ')).at(-1);
  if (child.status !== 0) return [`packages/gate/data/ceilings/worker-bundle.json:1: the runner worker bundle could not be measured at the step: ${step}: ${error}`];
  const bytes = Number(child.stdout);
  return bytes > recorded ? [`packages/gate/data/ceilings/worker-bundle.json:1: the runner worker bundle is ${bytes} raw bytes, over its recorded ${recorded}; cut what the worker imports, or record a lower size when it falls`] : [];
}

/**
 * Every whole-tree static check class, in the order submit reports them. `run(root, sources)` returns one message per
 * failure, where `sources` are the style sources of the tree read once. Together with the changed-file list in
 * `STATIC_CHECKS` this is the only place a static class is named (#3233).
 */
export const STATIC_TREE_CHECKS = Object.freeze([
  { name: 'test-waits', reads: TEST, run: (root, sources, context = MEMORY) => testWaitGrowth(testWaitReport(root, { cache: context.cache('test-waits', 1) }), JSON.parse(readFileSync(join(root, 'packages/gate/data/baselines/test-waits-baseline.json'), 'utf8')))
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'cli-launches', reads: TEST, run: (root, sources, context = MEMORY) => cliLaunchGrowth(cliLaunchReport(root, { cache: context.cache('cli-launches', 1) }), JSON.parse(readFileSync(join(root, 'packages/gate/data/baselines/cli-launches.json'), 'utf8')))
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  // A second entry point for an operation the registry names once, and a baseline that grows past main's (#5846).
  { name: 'operation-entries', reads: SOURCE, run: root => operationEntryProblems(root) },
  // Test sources are scanned one file at a time, so each file's sites are kept by blob [5567].
  { name: 'test-fixtures', reads: TEST, run: (root, sources, context = MEMORY) => {
    const cache = context.cache('test-fixtures', 1);
    return fixtureProblems(root, join(root, 'packages/gate/data/tests/test-fixtures.json'), { sitesOf: (path, text) => cache.get(path, blobOid(text), () => fixtureSites(text, path)) })
      .map(row => `${row.path}:${row.line}: ${row.text}`);
  } },
  { name: 'relay-boundary', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    const relay = readdirSync(join(root, 'apps/relay/src/io/deploy'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?js$/u.test(entry.name))
      .map(entry => ({ file: `apps/relay/src/io/deploy/${entry.name}`, source: readFileSync(repoPath(root, `apps/relay/src/io/deploy/${entry.name}`), 'utf8') }));
    // The check judges each file alone, so its rows are kept by blob [5567].
    const cache = context.cache('relay-boundary', 1);
    return [...treeSources(root, sources), ...relay].flatMap(row => cache.get(row.file, blobOid(row.source), () => relayBoundaryProblems([row]))).map(row => `${row.file}:${row.line}: ${row.text}`);
  } },
  // Package modules that newly reach the CLI front door; codemap's cell-lints ratchet sits below gate and cannot run this (#3808).
  // Cell-scoped: the answer reads the CLI's import closure on this tree and on main, so it is kept under the CLI cell's key plus main's commit [5567].
  { name: 'cli-reach', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    const main = mainCommit(root);
    if (!main) return [];
    const scope = cellScopedKey(treeSources(root, sources), ['apps/cli'], { edgeCache: edgeCacheOf(context) });
    return context.cache('cli-reach', 1).get('cli-reach', `${scope}:${main}`, () => cliReachRows(root));
  } },
  // Modules a test closure reaches whose imports the graph newly cannot read; both graphs are kept per commit (#5840).
  { name: 'keyless', reads: SOURCE, run: root => keylessRows(root) },
  // Edges are read per file by blob; the ceilings and the plan are read fresh each run [5567].
  { name: 'cells-edges', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    const cache = context.cache('file-edges', 1), text = new Map(treeSources(root, sources).map(row => [row.file, row.source]));
    return cellsEdgeProblems(root, {
      read: file => text.get(file) ?? readFileSync(join(root, file), 'utf8'),
      edgesOf: (file, source) => cache.get(file, blobOid(source), () => fileEdges(file, source)),
    }).map(row => `${row.path}:${row.line}: ${row.text}`);
  } },
  { name: 'test-cells', reads: SOURCE, run: (root, sources, context = MEMORY) => testCellsProblems(root, { cache: context.cache('test-cells', 1) }).map(row => `${row.path}:${row.line}: ${row.text}`) },
  // Repository paths in code that do not exist; the per-file count may only fall (#5302).
  { name: 'missing-paths', reads: SOURCE, run: (root, sources, context = MEMORY) => cachedMissingPaths(root, context) },
  // File-local: given the changed paths, only their sources are read.
  { name: 'import-style', reads: SOURCE, run: (root, sources, context = MEMORY) => importStyleRows(context.changed ? sources.filter(row => context.changed.includes(row.file)) : sources, context.cache('import-style', 1)).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`) },
  // Cell-partitioned: a cell's rows are kept under that cell's blobs plus the cells it imports [5567].
  { name: 'engine-folder', reads: SOURCE, run: (root, sources, context = MEMORY) => cellRows({ sources: treeSources(root, sources), edgeCache: edgeCacheOf(context), cache: context.cache('engine-folder', 1), compute: engineFolderViolations })
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line).map(row => `${row.file}:${row.line}: ${row.text}`) },
  { name: 'board-write-io', reads: SOURCE, run: (root, sources, context = MEMORY) => cellRows({ sources: treeSources(root, sources), edgeCache: edgeCacheOf(context), cache: context.cache('board-write-io', 1), compute: reach => boardWriteIoProblems(reach) })
    .map(row => `${row.file}:${row.line}: external I/O inside a board write: ${row.call} (${row.chain.join(' -> ')})`) },
  { name: 'worker-bundle', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    // Cell-scoped: the bundle is the import closure of the runners cell, so a tree that changed no file in runners or the cells it imports keeps the answer [5564].
    const scope = cellScopedKey(treeSources(root, sources), ['runners'], { edgeCache: edgeCacheOf(context), extra: ['package.json', 'packages/gate/data/ceilings/worker-bundle.json'], read: file => readFileSync(join(root, file), 'utf8') });
    return context.cache('worker-bundle', 1).get('worker-bundle', scope, () => workerBundleRows(root));
  } },
  { name: 'prose-commands', reads: path => path.startsWith('apps/cli/'), run: root => {
    const { declared, actual } = proseCommandSets(root);
    if (JSON.stringify(declared) === JSON.stringify(actual)) return [];
    const line = readFileSync(join(root, 'apps/cli/src/logic/help.js'), 'utf8').split('\n').findIndex(row => row.includes('export const PULLBOARD_COMMANDS')) + 1;
    return [`apps/cli/src/logic/help.js:${Math.max(1, line)}: prose command declaration differs from the CLI help catalog`];
  } },
  { name: 'wall-clock-budgets', reads: TEST, run: root => {
    const clock = spawnSync(process.execPath, ['packages/gate/tests/fixtures/budgets.js'], { cwd: root, encoding: 'utf8' });
    return clock.status === 0 ? [] : [`${clock.stdout}${clock.stderr}`.trim() || 'packages/gate/tests/fixtures/budgets.js failed'];
  } },
  // Given the changed paths, only the rules they touch run.
  { name: 'doctrine', reads: () => true, run: (root, sources, context = MEMORY) => doctrineReport(root, loadConfig(root), { changed: context.changed ?? null }).filter(row => !row.holds)
    .map(row => `doctrine ${row.id}: ${row.state}\n${row.problems.join('\n')}`) },
]);

/**
 * Run every whole-tree class on a checkout and collect every failure, in registry order. Given the paths a change touched
 * against a green main, a class that reads none of them is not run, and the file-local ones read only those paths [5814].
 *
 * @param {string} root - Checkout root.
 * @param {{changed?: string[] | null}} [scope] - The changed paths, when no whole-repo input changed; null runs every class whole.
 * @returns {string[]} One message per failure; empty when the tree is clean.
 */
export function runStaticTreeRegistry(root, { changed = null } = {}) {
  const sources = styleSources(root);
  const tooling = toolingKey(sources);
  const caches = [];
  const context = { changed, cache: (name, version) => { const made = fileCache({ name, version, tooling }); caches.push(made); return made; } };
  const rows = STATIC_TREE_CHECKS.filter(check => !changed || changed.some(path => check.reads(path))).flatMap(check => check.run(root, sources, context));
  for (const made of caches) made.save();
  return rows;
}

/**
 * Run one repository command in a checkout and return its output as one failure message, or nothing when it exits 0.
 *
 * @param {string} root - Checkout root.
 * @param {string[]} args - Node arguments naming the script and its flags.
 * @returns {string[]} The failure text, or an empty list.
 */
function commandFailures(root, args) {
  const ran = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', ...args], { cwd: root, encoding: 'utf8' });
  return ran.status === 0 ? [] : [`${ran.stdout}${ran.stderr}`.trim() || `${args.join(' ')} failed`];
}

/**
 * The classes submit judges as their own stages beside the static command: cells, cell lints and spec ids. Each runs its
 * repository command on a tree. They are listed here so every class submit runs is named once, but `runStaticTreeRegistry`
 * leaves them to their stages, which run them in parallel with their receipts (#3233).
 */
export const STATIC_STAGE_CHECKS = Object.freeze([
  { name: 'cells', run: root => commandFailures(root, ['packages/codemap/src/io/cells/scripts/plan.js', '--check']) },
  { name: 'cell-lints', run: root => commandFailures(root, ['packages/codemap/src/io/cell/scripts/lints.js', '--check', root]) },
  { name: 'spec-ids', run: root => commandFailures(root, ['apps/cli/pullboard.js', 'spec', 'check']) },
]);

/** Every static class name submit runs, whole-tree, changed-file and stage, each once. */
export const STATIC_CHECK_CLASSES = Object.freeze([...new Set([...STATIC_TREE_CHECKS, ...STATIC_CHECKS, ...STATIC_STAGE_CHECKS].map(check => check.name))]);
