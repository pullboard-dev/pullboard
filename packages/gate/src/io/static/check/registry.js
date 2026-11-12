import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importStyleViolations } from '../style.js';
import { engineFolderProblems } from '../../../../../state/index.js';
import { engineFolderViolations } from '../../../../../state/index.js';
import { emptyCatchProblems } from '../../catch.js';
import { fileSizeProblems } from '../../file/size.js';
import { testInputProblems } from '../../test/inputs.js';
import { testWaitSites } from '../../test/waits.js';
import { testWaitGrowth } from '../../test/waits.js';
import { relayBoundaryProblems } from '../../relay.js';
import { cellsEdgeProblems } from '../../edges.js';
import { assumptionProblems } from '../../../../../codemap/index.js';
import { syncSpawnProblems } from '../../../../../codemap/index.js';
import { fixedWallMargins } from '../../budgets.js';
import { EXPORT_ONLY_CEILINGS } from '../../../logic/export/only.js';
import { declaredDoorFiles } from '../../../logic/export/only.js';
import { exportOnlyProblems } from '../../../logic/export/only.js';
import { LOAD_BEARING_CEILINGS } from '../../../logic/load/bearing.js';
import { loadBearingFailures } from '../../../logic/load/bearing.js';
import { loadBearingJudged } from '../../../logic/load/bearing.js';
import { gitSpawnSync } from '../../../../../git/index.js';
import { compatibilityToggleProblems } from '../../../../../config/index.js';
import { INVENTORY_FILE } from '../../../../../config/index.js';
import { storeRegistryCheck } from '../../stores.js';
import { layoutProblems } from '../layout.js';

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
  // A src/ folder named test/ holds source, never tests [V32].
  return /\.[cm]?js$/u.test(file) && !/(?:^|\/)src\//u.test(file) && (/(?:^|\/)(?:tests?|journeys)\//u.test(file) || /(?:^|\/)(?:test|test[-_.].+|.+[-_.]test)\.[cm]?js$/u.test(file));
}

/**
 * The files this change moves, as new path to old path: what git reports as renamed against accepted main, which is
 * the same similarity test git uses for a deleted file and an added one. Why: a moved file carries its ceiling.
 *
 * @param {string} root
 * @param {boolean} staged - Judge the index rather than the working tree.
 * @returns {Record<string, string>}
 */
function movedPaths(root, staged) {
  const diff = gitSpawnSync(['diff', ...(staged ? ['--cached'] : []), '-M', '--name-status', '-z', '--diff-filter=R', 'refs/heads/main'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (diff.status !== 0) return {};
  const parts = diff.stdout.split('\0').filter(Boolean);
  const moves = {};
  for (let at = 0; at + 2 < parts.length; at += 3) moves[parts[at + 2]] = parts[at + 1];
  return moves;
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
  return loadBearingFailures(changed, ceilings, accepted, accepted ? movedPaths(root, staged) : {});
}

/**
 * The one list of static check classes submit judges on changed files. Each entry names the class and runs it on a
 * tree: `run` takes `{ root, files, staged, text, previous, read, sources, engineSources }` and returns one
 * `path:line: message` per failure. Submit, the pre-commit hook and `apps/cli/src/io/static/checks.js` all read this list,
 * so a class added here runs everywhere and appears once (#3233).
 */
export const STATIC_CHECKS = Object.freeze([
  { name: 'relay-boundary', run: ({ files, sources, read }) => relayBoundaryProblems([...sources, ...files.filter(file => /^apps\/relay\/src\/io\/deploy\/.*\.[cm]?js$/u.test(file)).map(read)])
    .map(row => `${row.file}:${row.line}: ${row.text}`) },
  // A new cross-cell import or deep import past a cell's index needs a plan declaration (packages/gate/src/io/edges.js).
  { name: 'cells-edges', run: ({ root, sources, text }) => cellsEdgeProblems(root, { files: sources.map(row => row.file), read: text })
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  // A synchronous child process in a module a leased job, driver or producer reaches freezes its lease timer (packages/codemap/src/io/sync-spawn-in-leases.js).
  { name: 'sync-spawn-in-leases', run: ({ root, text }) => syncSpawnProblems(root, { read: text })
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  // Core code names no test runner or operating system; those literals live in adapters (packages/codemap/src/io/no-runtime-assumptions.js).
  { name: 'no-runtime-assumptions', run: ({ root, text }) => assumptionProblems(root, { read: text })
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'import-style', run: ({ sources }) => importStyleViolations(sources).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`) },
  // The approved state metadata chain is proved across the whole tree, so judge the tree and report only changed files.
  { name: 'engine-folder', run: ({ root, files, staged, engineSources }) => (staged ? engineFolderViolations(engineSources) : engineFolderProblems(root))
    .filter(row => files.includes(row.file)).map(row => `${row.file}:${row.line}: ${row.text}`) },
  // A file of only exports outside a cell's index.js may leave the ceilings, never join them (packages/gate/src/logic/export/only.js).
  { name: 'export-only', run: ({ sources, text }) => {
    let allowed;
    try { allowed = JSON.parse(text(EXPORT_ONLY_CEILINGS)).files ?? []; } catch { return []; } // a project without the ceilings file has nothing to judge
    return exportOnlyProblems(sources, allowed, declaredDoorFiles(text)).map(row => `${row.path}:${row.line}: ${row.text}`);
  } },
  { name: 'empty-catch', run: growthCheck(emptyCatchProblems) },
  { name: 'file-size', run: growthCheck(fileSizeProblems) },
  { name: 'test-inputs', run: growthCheck(testInputProblems) },
  { name: 'load-bearing', run: loadBearingCheck },
  // A store path or table write outside its owner module, or an unregistered store, refuses [CD2] (packages/gate/src/io/stores.js).
  { name: 'store-registry', run: storeRegistryCheck },
  { name: 'wall-clock-margins', run: ({ files, read }) => files.filter(isTestSource).flatMap(file => fixedWallMargins(read(file).source, file)) },
  // Compatibility toggles carry a removeBy date; one past it, or a rising count, turns every submit red until removed [O6,C7].
  // The layout rule counts never rise above the tree's baseline; a whole-tree run, cheap, so the file list is ignored.
  { name: 'layout', run: ({ root }) => layoutProblems(root) },
  { name: 'compat-toggles', run: ({ text, previous, now }) => {
    let source;
    try { source = text(INVENTORY_FILE); } catch { return []; } // a project without the settings inventory has no toggles to judge
    return compatibilityToggleProblems(source, previous(INVENTORY_FILE) ?? '', now);
  } },
  { name: 'test-waits', run: ({ root, files, read }) => {
    const baseline = JSON.parse(readFileSync(join(root, 'packages/gate/data/baselines/test-waits-baseline.json'), 'utf8'));
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
