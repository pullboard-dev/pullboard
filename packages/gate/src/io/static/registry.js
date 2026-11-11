/** The whole-tree static check classes `apps/cli/src/io/static/checks.js` runs, listed once with a runner each [C7]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { styleSources } from '../../../../codemap/index.js';
import { importStyleViolations } from '../../../index.js';
import { engineFolderProblems } from '../../../../state/index.js';
import { doctrineReport } from '../../../../doctrine/index.js';
import { loadConfig } from '../../../../config/index.js';
import { testWaitReport } from '../test/waits.js';
import { testWaitGrowth } from '../test/waits.js';
import { boardWriteIoProblems } from '../board/write.js';
import { relayBoundaryProblems } from '../relay.js';
import { fixtureProblems } from '../test/fixtures.js';
import { cellsEdgeProblems } from '../edges.js';
import { testCellsProblems } from '../test/cells.js';
import {
  missingPathFindings,
  missingPathGrowth,
  readMissingPathBaseline,
} from '../paths/lint.js';
import { STATIC_CHECKS } from '../../../index.js';
import { cliReachRows } from '../../../index.js';
import { repoPath } from '../../../../kernel/light.js';
import { blobOid } from './cache.js';
import { fileCache } from './cache.js';
import { toolingKey } from './cache.js';
import { cellScopedKey } from './cache.js';

/** The context a check gets when called on its own: caches that live and die inside the call. */
const MEMORY = Object.freeze({ cache: (name, version) => fileCache({ name, version, tooling: '', home: null }) });

/** Import-style violations, one source at a time: each file's rows depend on that file alone, so they are kept by blob [5564]. */
function importStyleRows(sources, cache) {
  return sources.flatMap(source => cache.get(source.file, blobOid(source.source), () => importStyleViolations([source])));
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

/**
 * Measure the runner worker bundle in a child process and compare it with its recorded ceiling.
 *
 * @param {string} root - Checkout root.
 * @returns {string[]} The failure, or nothing.
 */
function workerBundleRows(root) {
  // The runner worker bundle's raw size may only fall; growth fails here, never silently at a runner (#4140).
  const recorded = JSON.parse(readFileSync(join(root, 'packages/gate/data/ceilings/worker-bundle.json'), 'utf8')).bytes;
  const program = `const { workerBundleBytes } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/runners/index.js')).href)});\nprocess.stdout.write(String(workerBundleBytes(${JSON.stringify(root)})));`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program], { cwd: root, encoding: 'utf8' });
  if (child.status !== 0) return [`packages/gate/data/ceilings/worker-bundle.json:1: the runner worker bundle could not be measured: ${child.stderr.trim().split('\n').at(-1)}`];
  const bytes = Number(child.stdout);
  return bytes > recorded ? [`packages/gate/data/ceilings/worker-bundle.json:1: the runner worker bundle is ${bytes} raw bytes, over its recorded ${recorded}; cut what the worker imports, or record a lower size when it falls`] : [];
}

/**
 * Every whole-tree static check class, in the order submit reports them. `run(root, sources)` returns one message per
 * failure, where `sources` are the style sources of the tree read once. Together with the changed-file list in
 * `STATIC_CHECKS` this is the only place a static class is named (#3233).
 */
export const STATIC_TREE_CHECKS = Object.freeze([
  { name: 'test-waits', run: (root, sources, context = MEMORY) => testWaitGrowth(testWaitReport(root, { cache: context.cache('test-waits', 1) }), JSON.parse(readFileSync(join(root, 'packages/gate/data/baselines/test-waits-baseline.json'), 'utf8')))
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'test-fixtures', run: root => fixtureProblems(root, join(root, 'packages/gate/data/tests/test-fixtures.json')).map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'relay-boundary', run: (root, sources) => {
    const relay = readdirSync(join(root, 'apps/relay/src/io/deploy'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?js$/u.test(entry.name))
      .map(entry => ({ file: `apps/relay/src/io/deploy/${entry.name}`, source: readFileSync(repoPath(root, `apps/relay/src/io/deploy/${entry.name}`), 'utf8') }));
    return relayBoundaryProblems([...sources, ...relay]).map(row => `${row.file}:${row.line}: ${row.text}`);
  } },
  // Package modules that newly reach the CLI front door; codemap's cell-lints ratchet sits below gate and cannot run this (#3808).
  { name: 'cli-reach', run: root => cliReachRows(root) },
  { name: 'cells-edges', run: root => cellsEdgeProblems(root).map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'test-cells', run: (root, sources, context = MEMORY) => testCellsProblems(root, { cache: context.cache('test-cells', 1) }).map(row => `${row.path}:${row.line}: ${row.text}`) },
  // Repository paths in code that do not exist; the per-file count may only fall (#5302).
  { name: 'missing-paths', run: root => missingPathGrowth(missingPathFindings(root), readMissingPathBaseline(root)) },
  { name: 'import-style', run: (root, sources, context = MEMORY) => importStyleRows(sources, context.cache('import-style', 1)).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`) },
  { name: 'engine-folder', run: root => engineFolderProblems(root).map(row => `${row.file}:${row.line}: ${row.text}`) },
  { name: 'board-write-io', run: (root, sources) => boardWriteIoProblems(sources)
    .map(row => `${row.file}:${row.line}: external I/O inside a board write: ${row.call} (${row.chain.join(' -> ')})`) },
  { name: 'worker-bundle', run: (root, sources, context = MEMORY) => {
    // Cell-scoped: the bundle is the import closure of the runners cell, so a tree that changed no file in runners or the cells it imports keeps the answer [5564].
    const scope = cellScopedKey(sources ?? styleSources(root), ['runners'], { edgeCache: context.cache('cell-edges', 1), extra: ['package.json', 'packages/gate/data/ceilings/worker-bundle.json'], read: file => readFileSync(join(root, file), 'utf8') });
    return context.cache('worker-bundle', 1).get('worker-bundle', scope, () => workerBundleRows(root));
  } },
  { name: 'prose-commands', run: root => {
    const { declared, actual } = proseCommandSets(root);
    if (JSON.stringify(declared) === JSON.stringify(actual)) return [];
    const line = readFileSync(join(root, 'apps/cli/src/logic/help.js'), 'utf8').split('\n').findIndex(row => row.includes('export const PULLBOARD_COMMANDS')) + 1;
    return [`apps/cli/src/logic/help.js:${Math.max(1, line)}: prose command declaration differs from the CLI help catalog`];
  } },
  { name: 'wall-clock-budgets', run: root => {
    const clock = spawnSync(process.execPath, ['packages/gate/tests/fixtures/budgets.js'], { cwd: root, encoding: 'utf8' });
    return clock.status === 0 ? [] : [`${clock.stdout}${clock.stderr}`.trim() || 'packages/gate/tests/fixtures/budgets.js failed'];
  } },
  { name: 'doctrine', run: root => doctrineReport(root, loadConfig(root)).filter(row => !row.holds)
    .map(row => `doctrine ${row.id}: ${row.state}\n${row.problems.join('\n')}`) },
]);

/**
 * Run every whole-tree class on a checkout and collect every failure, in registry order.
 *
 * @param {string} root - Checkout root.
 * @returns {string[]} One message per failure; empty when the tree is clean.
 */
export function runStaticTreeRegistry(root) {
  const sources = styleSources(root);
  const tooling = toolingKey(sources);
  const caches = [];
  const context = { cache: (name, version) => { const made = fileCache({ name, version, tooling }); caches.push(made); return made; } };
  const rows = STATIC_TREE_CHECKS.flatMap(check => check.run(root, sources, context));
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
