/**
 * The whole-tree static check classes the CLI's static entry runs, listed once with a runner each [C7].
 *
 * The classes that read an app's files take those paths from the caller as `apps`, so this file names no app path:
 * `{ cliCell, cliIndex, cliHelp, relayDeploy, specCheck }`, each a repo-relative path except `specCheck`, the node arguments
 * of the spec check. A class that needs an app path and gets none reports that as its failure rather than passing silently.
 */
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
import { requireRegisteredEnabled } from '../../../../config/index.js';
import { adapterLintClockEnabled } from '../../../../config/index.js';
import { clockLintRows } from '../adapter-lints/clock.js';
import { testWaitReport } from '../test/waits.js';
import { cliLaunchReport } from '../test/launches.js';
import { cliLaunchGrowth } from '../test/launches.js';
import { cliChildImportProblems } from '../test/child-fixture.js';
import { operationEntryProblems } from './operations.js';
import { workerImportProblems } from './worker-imports.js';
import { WORKER_IMPORTS_FILE } from './worker-imports.js';
import { layoutProblems } from './layout.js';
import { testWaitGrowth } from '../test/waits.js';
import { boardWriteIoProblems } from '../board/write.js';
import { apiRequestIoProblems } from '../board/request.js';
import { candidateKnownBlockers } from '../board/request.js';
import { relayBoundaryProblems } from '../relay.js';
import { fixtureProblems } from '../test/fixtures.js';
import { fixtureSites } from '../test/fixtures.js';
import { unregisteredTestRows } from '../test/unregistered.js';
import { cellsEdgeProblems } from '../edges.js';
import { fileEdges } from '../edges.js';
import { testCellsProblems } from '../test/cells.js';
import {
  fileFindings,
  missingPathFindings,
  missingPathGrowth,
  readMissingPathBaseline,
} from '../paths/lint.js';
import { STATIC_CHECKS } from './check/registry.js';
import { cliReachRows } from '../../../index.js';
import { keylessRows } from '../../../index.js';
import { repoPath } from '../../../../kernel/light.js';
import { blobOid } from './cache.js';
import { fileCache } from './cache.js';
import { toolingKey } from './cache.js';
import { cellRows } from './cache.js';
import { cellScopedKey } from './cache.js';

/** The per-file CLI launch ceilings, as a repo-relative path [C7]. */
export const CLI_LAUNCHES_FILE = 'packages/gate/data/baselines/cli-launches.json';

/** What a check reads, so a change to none of those paths keeps main's answer [5814]: JavaScript sources, and test files among them. */
const SOURCE = path => /\.[cm]?js$/u.test(path);
const TEST = path => SOURCE(path) && (path.split('/').slice(0, -1).some(part => part === 'tests' || part === 'test') || /[-_.]test\.[cm]?js$/u.test(path));

/** The failure a class reports when its caller passed no app paths. */
const noApps = name => [`${name}: the caller passed no app paths; hand them in as the apps option of runStaticTreeRegistry`];

/** The context a check gets when called on its own: caches that live and die inside the call. */
const MEMORY = Object.freeze({ cache: (name, version) => fileCache({ name, version, tooling: '', home: null }), report: line => process.stderr.write(`${line}\n`) });

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
  const files = context.changed ? context.changed.filter(path => SOURCE(path) && existsSync(resolve(root, path))).sort() : undefined;
  return missingPathGrowth(missingPathFindings(root, { findingsOf, files }), readMissingPathBaseline(root));
}

/**
 * Read the declared prose commands and the CLI catalog from the tree being checked, in a child process started in that tree.
 * The gate runs this file from a copy of main, so importing the catalog here would judge main's catalog, never the item's:
 * a catalog fix could not pass the check it fixes (#3827).
 *
 * @param {string} root - Checkout root.
 * @param {string} cliIndex - The CLI's front door, relative to the root.
 * @returns {{declared: string[], actual: string[]}} Both lists, sorted.
 */
function proseCommandSets(root, cliIndex) {
  const entry = pathToFileURL(join(root, cliIndex)).href;
  const program = `const { HELP, declaredProseCommands, PULLBOARD_COMMANDS } = await import(${JSON.stringify(entry)});
process.stdout.write(JSON.stringify({ declared: [...declaredProseCommands(HELP)].sort(), actual: [...PULLBOARD_COMMANDS].sort() }));`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program], { cwd: root, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`prose-commands could not read the catalog of ${root}: ${child.stderr.trim()}`);
  return JSON.parse(child.stdout);
}

/** The measurement takes about a second; a minute is ample on a loaded gate and still ends a hung child [5642]. */
const WORKER_BUNDLE_TIMEOUT_MS = 60_000;

/**
 * Measure the runner worker bundle in a child process and describe its size against the recorded number.
 *
 * Why: bytes are reported, never enforced; the trust and speed guards are the reviewed import list and the per-trip budget. Only a
 * measurement that cannot run is a failure, because a size nobody can read is no report.
 *
 * @param {string} root - Checkout root.
 * @returns {{rows: string[], line: string}} The failure (if any) and the report line.
 */
function workerBundleReport(root) {
  const recorded = JSON.parse(readFileSync(join(root, 'packages/gate/data/ceilings/worker-bundle.json'), 'utf8')).bytes;
  // Each phase is written to stderr as it starts, so a measurement past its deadline names the step that hung [5642].
  const program = `const { workerBundleBytes } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/runners/index.js')).href)});\nprocess.stdout.write(String(workerBundleBytes(${JSON.stringify(root)}, undefined, step => process.stderr.write('step: ' + step + '\\n'))));`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program], { cwd: root, encoding: 'utf8', timeout: WORKER_BUNDLE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const lines = (child.stderr ?? '').trim().split('\n');
  const step = lines.filter(line => line.startsWith('step: ')).at(-1)?.slice(6) ?? 'start the measuring process';
  if (child.error?.code === 'ETIMEDOUT') return { rows: [`packages/gate/data/ceilings/worker-bundle.json:1: the runner worker bundle measurement passed ${WORKER_BUNDLE_TIMEOUT_MS / 1000} s at the step: ${step}`], line: '' };
  const error = lines.find(line => /^\w*(Error|Refused)\b/u.test(line)) ?? lines.filter(line => !line.startsWith('step: ')).at(-1);
  if (child.status !== 0) return { rows: [`packages/gate/data/ceilings/worker-bundle.json:1: the runner worker bundle could not be measured at the step: ${step}: ${error}`], line: '' };
  const bytes = Number(child.stdout);
  const change = bytes - recorded;
  return { rows: [], line: `runner worker bundle: ${bytes} raw bytes, ${change === 0 ? 'unchanged from' : `${change > 0 ? '+' : ''}${change} against`} the recorded ${recorded} (reported, not enforced)` };
}

/**
 * Every whole-tree static check class, in the order submit reports them. `run(root, sources)` returns one message per
 * failure, where `sources` are the style sources of the tree read once. Together with the changed-file list in
 * `STATIC_CHECKS` this is the only place a static class is named (#3233).
 */
export const STATIC_TREE_CHECKS = Object.freeze([
  { name: 'test-waits', reads: TEST, run: (root, sources, context = MEMORY) => testWaitGrowth(testWaitReport(root, { cache: context.cache('test-waits', 1), only: context.changed }), JSON.parse(readFileSync(join(root, 'packages/gate/data/baselines/test-waits-baseline.json'), 'utf8')))
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'cli-launches', reads: TEST, run: (root, sources, context = MEMORY) => cliLaunchGrowth(cliLaunchReport(root, { cache: context.cache('cli-launches', 1), only: context.changed }), JSON.parse(readFileSync(join(root, CLI_LAUNCHES_FILE), 'utf8')))
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  // A new package test may not import the CLI app's child fixture outside the named exceptions; judged against where the branch met main [#8435].
  { name: 'cli-child-import', reads: TEST, run: (root, sources, context = MEMORY) => cliChildImportProblems(root, { only: context.changed })
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  // A second entry point for an operation the registry names once, and a baseline that grows past main's (#5846).
  { name: 'operation-entries', reads: SOURCE, run: root => operationEntryProblems(root) },
  // Test sources are scanned one file at a time, so each file's sites are kept by blob [5567].
  { name: 'test-fixtures', reads: TEST, run: (root, sources, context = MEMORY) => {
    const cache = context.cache('test-fixtures', 1);
    return fixtureProblems(root, join(root, 'packages/gate/data/tests/test-fixtures.json'), { only: context.changed, sitesOf: (path, text) => cache.get(path, blobOid(text), () => fixtureSites(text, path)) })
      .map(row => `${row.path}:${row.line}: ${row.text}`);
  } },
  { name: 'relay-boundary', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    const folder = context.apps?.relayDeploy;
    if (!folder) return noApps('relay-boundary');
    const relay = readdirSync(join(root, folder), { withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?js$/u.test(entry.name))
      .map(entry => ({ file: `${folder}/${entry.name}`, source: readFileSync(repoPath(root, `${folder}/${entry.name}`), 'utf8') }));
    // The check judges each file alone, so its rows are kept by blob [5567].
    const cache = context.cache('relay-boundary', 1);
    return [...treeSources(root, sources), ...relay].filter(row => !context.changed || context.changed.includes(row.file)).flatMap(row => cache.get(row.file, blobOid(row.source), () => relayBoundaryProblems([row]))).map(row => `${row.file}:${row.line}: ${row.text}`);
  } },
  // Package modules that newly reach the CLI front door; codemap's cell-lints ratchet sits below gate and cannot run this (#3808).
  // Cell-scoped: the answer reads the CLI's import closure on this tree and on main, so it is kept under the CLI cell's key plus main's commit [5567].
  { name: 'cli-reach', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    const main = mainCommit(root);
    if (!main) return [];
    if (!context.apps?.cliCell) return cliReachRows(root);
    const scope = cellScopedKey(treeSources(root, sources), [context.apps.cliCell], { edgeCache: edgeCacheOf(context) });
    return context.cache('cli-reach', 1).get('cli-reach', `${scope}:${main}`, () => cliReachRows(root));
  } },
  // A tracked file that raises a layout rule count above the tree's own baseline (packages/gate/src/io/static/layout.js).
  { name: 'layout', reads: () => true, run: root => layoutProblems(root) },
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
  // A test file the change adds without a registry record or golden path: refused with tests.requireRegistered on, else one diagnostic line (#9402).
  { name: 'test-registered', reads: TEST, run: (root, sources, context = MEMORY) => {
    const rows = unregisteredTestRows(root, { only: context.changed });
    if (context.requireRegistered ?? requireRegisteredEnabled()) return rows;
    for (const row of rows) (context.report ?? MEMORY.report)(`diagnostic (tests.requireRegistered off): ${row}`);
    return [];
  } },
  { name: 'test-cells', reads: SOURCE, run: (root, sources, context = MEMORY) => testCellsProblems(root, { cache: context.cache('test-cells', 1) }).map(row => `${row.path}:${row.line}: ${row.text}`) },
  // Repository paths in code that do not exist; the per-file count may only fall (#5302).
  { name: 'missing-paths', reads: SOURCE, run: (root, sources, context = MEMORY) => cachedMissingPaths(root, context) },
  // Direct Date.now and timer reads outside the kernel; each file's count may only fall, and off (gate.adapterLintClock) it reports nothing (#9447).
  { name: 'adapter-lint-clock', reads: SOURCE, run: (root, sources, context = MEMORY) => clockLintRows(root, { enabled: context.adapterLintClock ?? adapterLintClockEnabled() }) },
  // File-local: given the changed paths, only their sources are read.
  { name: 'import-style', reads: SOURCE, run: (root, sources, context = MEMORY) => importStyleRows(context.changed ? sources.filter(row => context.changed.includes(row.file)) : sources, context.cache('import-style', 1)).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`) },
  // Cell-partitioned: a cell's rows are kept under that cell's blobs plus the cells it imports [5567].
  { name: 'engine-folder', reads: SOURCE, run: (root, sources, context = MEMORY) => cellRows({ sources: treeSources(root, sources), edgeCache: edgeCacheOf(context), cache: context.cache('engine-folder', 1), compute: engineFolderViolations })
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line).map(row => `${row.file}:${row.line}: ${row.text}`) },
  { name: 'board-write-io', reads: SOURCE, run: (root, sources, context = MEMORY) => cellRows({ sources: treeSources(root, sources), edgeCache: edgeCacheOf(context), cache: context.cache('board-write-io', 1), compute: reach => boardWriteIoProblems(reach) })
    .map(row => `${row.file}:${row.line}: external I/O inside a board write: ${row.call} (${row.chain.join(' -> ')})`) },
  // Reach from the API's request handlers; the known-violation set in request.js may only shrink [#6718].
  { name: 'api-request-io', reads: SOURCE, run: (root, sources) => apiRequestIoProblems(treeSources(root, sources), { known: candidateKnownBlockers(treeSources(root, sources)) })
    .map(row => `${row.file}:${row.line}: ${row.stale ? 'known request blocker no longer fires; delete its row' : 'synchronous child process reachable from a board API request'}: ${row.call} (${row.chain.join(' -> ')})`) },
  { name: 'worker-bundle', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    // Cell-scoped: the bundle is the import closure of the runners cell, so a tree that changed no file in runners or the cells it imports keeps the answer [5564].
    const scope = cellScopedKey(treeSources(root, sources), ['runners'], { edgeCache: edgeCacheOf(context), extra: ['package.json', 'packages/gate/data/ceilings/worker-bundle.json'], read: file => readFileSync(join(root, file), 'utf8') });
    const { rows, line } = context.cache('worker-bundle', 2).get('worker-bundle', scope, () => workerBundleReport(root));
    if (line) (context.report ?? MEMORY.report)(line);
    return rows;
  } },
  // The worker may import only from a reviewed list of units; cell-scoped like the bundle, since the closure is the runners cell's [#8461].
  { name: 'worker-imports', reads: SOURCE, run: (root, sources, context = MEMORY) => {
    const scope = cellScopedKey(treeSources(root, sources), ['runners'], { edgeCache: edgeCacheOf(context), extra: ['package.json', WORKER_IMPORTS_FILE], read: file => readFileSync(join(root, file), 'utf8') });
    return context.cache('worker-imports', 1).get('worker-imports', scope, () => workerImportProblems(root));
  } },
  { name: 'prose-commands', reads: (path, apps) => Boolean(apps?.cliCell) && path.startsWith(`${apps.cliCell}/`), run: (root, sources, context = MEMORY) => {
    if (!context.apps?.cliHelp) return noApps('prose-commands');
    const { declared, actual } = proseCommandSets(root, context.apps.cliIndex);
    if (JSON.stringify(declared) === JSON.stringify(actual)) return [];
    const helpFile = context.apps.cliHelp;
    const line = readFileSync(join(root, helpFile), 'utf8').split('\n').findIndex(row => row.includes('export const PULLBOARD_COMMANDS')) + 1;
    return [`${helpFile}:${Math.max(1, line)}: prose command declaration differs from the CLI help catalog`];
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
 * @param {{changed?: string[] | null, apps?: object}} [scope] - The changed paths, when no whole-repo input changed (null runs every class whole), and the app paths the caller hands in.
 * @returns {string[]} One message per failure; empty when the tree is clean.
 */
export function runStaticTreeRegistry(root, { changed = null, apps = null } = {}) {
  const sources = styleSources(root);
  const tooling = toolingKey(sources);
  const caches = [];
  const context = { changed, apps, report: MEMORY.report, cache: (name, version) => { const made = fileCache({ name, version, tooling }); caches.push(made); return made; } };
  const rows = STATIC_TREE_CHECKS.filter(check => !changed || changed.some(path => check.reads(path, apps))).flatMap(check => check.run(root, sources, context));
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
  { name: 'spec-ids', run: (root, apps) => apps?.specCheck ? commandFailures(root, apps.specCheck) : noApps('spec-ids') },
]);

/** Every static class name submit runs, whole-tree, changed-file and stage, each once. */
export const STATIC_CHECK_CLASSES = Object.freeze([...new Set([...STATIC_TREE_CHECKS, ...STATIC_CHECKS, ...STATIC_STAGE_CHECKS].map(check => check.name))]);
