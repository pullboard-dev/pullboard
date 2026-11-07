import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importStyleViolations } from './static-import-style.js';
import { engineFolderProblems } from '../../../state/index.js';
import { engineFolderViolations } from '../../../state/index.js';
import { emptyCatchProblems } from '../../../../bin/checks/empty-catch.js';
import { fileSizeProblems } from '../../../../bin/checks/file-size.js';
import { testInputProblems } from '../../../../bin/checks/test-inputs.js';
import { testWaitSites } from '../../../../bin/checks/test-waits.js';
import { testWaitGrowth } from '../../../../bin/checks/test-waits.js';
import { relayBoundaryProblems } from '../../../../bin/checks/relay-boundary.js';
import { cellsEdgeProblems } from '../../../../bin/checks/cells-edges.js';
import { fixedWallMargins } from './wall-clock-budgets.js';
import { LOAD_BEARING_CEILINGS } from '../core/load-bearing.js';
import { loadBearingFailures } from '../core/load-bearing.js';
import { loadBearingJudged } from '../core/load-bearing.js';
import { gitSpawnSync } from '../../../git/index.js';

/**
 * Per-file checks that judge a file against the same file on accepted main, so only newly added problems fail.
 *
 * @param {(root: string, files: string[], read: (file: string) => string) => {path: string, line: number, text: string}[]} check
 * @returns {(context: object) => string[]}
 */
function growthCheck(check) {
  return ({ root, files, text, previous }) => files.flatMap(file => check(root, [file], text).slice(check(root, [file], previous).length)
    .map(row => `${row.path}:${row.line}: ${row.text}`));
}

/** Whether a path is a test source the wall-clock and wait checks judge. */
function isTestSource(file) {
  return /\.[cm]?js$/u.test(file) && (/(?:^|\/)test\//u.test(file) || /(?:^|\/)(?:test|test[-_.].+|.+[-_.]test)\.[cm]?js$/u.test(file));
}

/**
 * The load-bearing process check over the changed files: new detached children, unrefs, daemon loops and state files
 * outside the drive, transport, jobs and pin cells, against the ceilings file, which may only fall against main's.
 * A checkout with no ceilings file (a project that is not this repository) has nothing to judge.
 *
 * @param {{ root: string, files: string[], staged: boolean, text: (file: string) => string, previous: (file: string) => string }} context
 * @returns {string[]}
 */
function loadBearingCheck({ root, files, staged, text, previous }) {
  const present = staged
    ? gitSpawnSync(['cat-file', '-e', `:${LOAD_BEARING_CEILINGS}`], { cwd: root, stdio: 'ignore' }).status === 0
    : existsSync(join(root, LOAD_BEARING_CEILINGS));
  if (!present) return [];
  const ceilings = JSON.parse(text(LOAD_BEARING_CEILINGS));
  const changed = files.filter(loadBearingJudged).map(file => ({ file, source: text(file) }));
  let accepted = null;
  if (files.includes(LOAD_BEARING_CEILINGS)) {
    const main = previous(LOAD_BEARING_CEILINGS);
    if (main) accepted = JSON.parse(main);
  }
  return loadBearingFailures(changed, ceilings, accepted);
}

/**
 * The one list of static check classes submit judges on changed files. Each entry names the class and runs it on a
 * tree: `run` takes `{ root, files, staged, text, previous, read, sources, engineSources }` and returns one
 * `path:line: message` per failure. Submit, the pre-commit hook and `bin/static-style-checks.js` all read this list,
 * so a class added here runs everywhere and appears once (#3233).
 */
export const STATIC_CHECKS = Object.freeze([
  { name: 'relay-boundary', run: ({ files, sources, read }) => relayBoundaryProblems([...sources, ...files.filter(file => /^relay\/.*\.[cm]?js$/u.test(file)).map(read)])
    .map(row => `${row.file}:${row.line}: ${row.text}`) },
  // A new cross-cell import or deep import past a cell's index needs a plan declaration (bin/checks/cells-edges.js).
  { name: 'cells-edges', run: ({ root, sources, text }) => cellsEdgeProblems(root, { files: sources.map(row => row.file), read: text })
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'import-style', run: ({ sources }) => importStyleViolations(sources).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`) },
  // The approved state metadata chain is proved across the whole tree, so judge the tree and report only changed files.
  { name: 'engine-folder', run: ({ root, files, staged, engineSources }) => (staged ? engineFolderViolations(engineSources) : engineFolderProblems(root))
    .filter(row => files.includes(row.file)).map(row => `${row.file}:${row.line}: ${row.text}`) },
  { name: 'empty-catch', run: growthCheck(emptyCatchProblems) },
  { name: 'file-size', run: growthCheck(fileSizeProblems) },
  { name: 'test-inputs', run: growthCheck(testInputProblems) },
  { name: 'load-bearing', run: loadBearingCheck },
  { name: 'wall-clock-margins', run: ({ files, read }) => files.filter(isTestSource).flatMap(file => fixedWallMargins(read(file).source, file)) },
  { name: 'test-waits', run: ({ root, files, read }) => {
    const baseline = JSON.parse(readFileSync(join(root, 'bin/checks/test-waits-baseline.json'), 'utf8'));
    return files.filter(isTestSource).flatMap(file => testWaitGrowth(testWaitSites(read(file).source, file), baseline).map(row => `${row.path}:${row.line}: ${row.text}`));
  } },
]);

/**
 * Run every registered static check on a tree and collect every failure, in registry order.
 *
 * @param {object} context - See STATIC_CHECKS.
 * @returns {string[]}
 */
export function runStaticRegistry(context) {
  return STATIC_CHECKS.flatMap(check => check.run(context));
}
