/** The whole-tree static check classes `bin/static-style-checks.js` runs, listed once with a runner each [C7]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { styleSources } from '../../packages/codemap/index.js';
import { importStyleViolations } from '../../packages/gate/index.js';
import { engineFolderProblems } from '../../packages/state/index.js';
import { declaredProseCommands } from '../../apps/cli/index.js';
import { doctrineReport } from '../../packages/doctrine/index.js';
import { loadConfig } from '../../packages/config/index.js';
import { HELP } from '../../apps/cli/index.js';
import { PULLBOARD_COMMANDS } from '../../apps/cli/index.js';
import { viewPureGate } from './view-pure.js';
import { testWaitReport } from './test-waits.js';
import { testWaitGrowth } from './test-waits.js';
import { boardWriteIoProblems } from './board-write-io.js';
import { relayBoundaryProblems } from './relay-boundary.js';
import { fixtureProblems } from './test-fixtures.js';
import { cellsEdgeProblems } from './cells-edges.js';
import { STATIC_CHECKS } from '../../packages/gate/index.js';

/**
 * Every whole-tree static check class, in the order submit reports them. `run(root, sources)` returns one message per
 * failure, where `sources` are the style sources of the tree read once. Together with the changed-file list in
 * `STATIC_CHECKS` this is the only place a static class is named (#3233).
 */
export const STATIC_TREE_CHECKS = Object.freeze([
  { name: 'test-waits', run: root => testWaitGrowth(testWaitReport(root), JSON.parse(readFileSync(join(root, 'bin/checks/test-waits-baseline.json'), 'utf8')))
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'test-fixtures', run: root => fixtureProblems(root, join(root, 'bin/checks/test-fixtures.json')).map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'relay-boundary', run: (root, sources) => {
    const relay = readdirSync(join(root, 'relay'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?js$/u.test(entry.name))
      .map(entry => ({ file: `relay/${entry.name}`, source: readFileSync(join(root, 'relay', entry.name), 'utf8') }));
    return relayBoundaryProblems([...sources, ...relay]).map(row => `${row.file}:${row.line}: ${row.text}`);
  } },
  { name: 'cells-edges', run: root => cellsEdgeProblems(root).map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'import-style', run: (root, sources) => importStyleViolations(sources).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`) },
  { name: 'engine-folder', run: root => engineFolderProblems(root).map(row => `${row.file}:${row.line}: ${row.text}`) },
  { name: 'view-pure', run: root => viewPureGate(root).failures.map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'board-write-io', run: (root, sources) => boardWriteIoProblems(sources)
    .map(row => `${row.file}:${row.line}: external I/O inside a board write: ${row.call} (${row.chain.join(' -> ')})`) },
  { name: 'prose-commands', run: root => {
    const declared = [...declaredProseCommands(HELP)].sort();
    const actual = [...PULLBOARD_COMMANDS].sort();
    if (JSON.stringify(declared) === JSON.stringify(actual)) return [];
    const line = readFileSync(join(root, 'src/cockpit.js'), 'utf8').split('\n').findIndex(row => row.includes('export const PULLBOARD_COMMANDS')) + 1;
    return [`src/cockpit.js:${Math.max(1, line)}: prose command declaration differs from the CLI help catalog`];
  } },
  { name: 'wall-clock-budgets', run: root => {
    const clock = spawnSync(process.execPath, ['test/wall-clock-budgets.js'], { cwd: root, encoding: 'utf8' });
    return clock.status === 0 ? [] : [`${clock.stdout}${clock.stderr}`.trim() || 'test/wall-clock-budgets.js failed'];
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
  return STATIC_TREE_CHECKS.flatMap(check => check.run(root, sources));
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
  { name: 'cells', run: root => commandFailures(root, ['bin/cells-plan.js', '--check']) },
  { name: 'cell-lints', run: root => commandFailures(root, ['bin/cell-lints.js', '--check', root]) },
  { name: 'spec-ids', run: root => commandFailures(root, ['bin/pullboard.js', 'spec', 'check']) },
]);

/** Every static class name submit runs, whole-tree, changed-file and stage, each once. */
export const STATIC_CHECK_CLASSES = Object.freeze([...new Set([...STATIC_TREE_CHECKS, ...STATIC_CHECKS, ...STATIC_STAGE_CHECKS].map(check => check.name))]);
