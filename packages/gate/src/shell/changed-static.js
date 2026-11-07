/** The gate's changed-file static checks as one function, so the gate and the pre-commit hook run the same list [C7]. */
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
import { fixedWallMargins } from './wall-clock-budgets.js';
import { LOAD_BEARING_CEILINGS } from '../core/load-bearing.js';
import { loadBearingFailures } from '../core/load-bearing.js';
import { loadBearingJudged } from '../core/load-bearing.js';
import { gitSpawnSync } from '../../../git/index.js';

/**
 * Judge only the named files with the static checks the gate runs on changed files.
 *
 * @param {string} root - Checkout root the files are read from.
 * @param {string[]} files - Root-relative changed or staged paths.
 * @returns {string[]} One `path:line: message` per failure; empty when clean.
 */
export function changedStaticFailures(root, files, { staged = false } = {}) {
  const cache = new Map();
  const accepted = new Map();
  /** Existing debt is read from accepted main, never the candidate working tree or a baseline file. */
  const previous = file => {
    if (!accepted.has(file)) {
      const result = gitSpawnSync(['show', `refs/heads/main:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const exists = gitSpawnSync(['ls-tree', '-z', 'refs/heads/main', '--', file], { cwd: root, encoding: 'utf8' });
        if (exists.status !== 0 || exists.stdout) throw new Error(`cannot read accepted static source ${file}: ${result.stderr}`);
      }
      accepted.set(file, result.status === 0 ? result.stdout : '');
    }
    return accepted.get(file);
  };
  /** Read each exact candidate source once, from the index for a commit hook. */
  const text = file => {
    if (!cache.has(file)) {
      if (staged) {
        const result = gitSpawnSync(['show', `:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(`cannot read staged ${file}: ${result.stderr || result.error?.message}`);
        cache.set(file, result.stdout);
      } else cache.set(file, readFileSync(join(root, file), 'utf8'));
    }
    return cache.get(file);
  };
  /** Bind each checker row to its root-relative path and exact candidate bytes. */
  const read = file => ({ file, source: text(file) });
  const sources = files.filter(file => /^(?:src|packages|apps)\//u.test(file) && /\.[cm]?js$/u.test(file)).map(read);
  let engineSources = sources;
  if (staged && sources.some(row => row.source.includes('EXIT_RULES_ENGINE'))) {
    const paths = gitSpawnSync(['ls-files', '-z', '--', 'src/exit-rules-engine.js', 'packages/state/core.js', 'packages/state/src/core'], { cwd: root, encoding: 'utf8' });
    if (paths.status !== 0) throw new Error('cannot list staged state metadata');
    const extra = paths.stdout.split('\0').filter(file => file && !files.includes(file) && /\.[cm]?js$/u.test(file));
    engineSources = [...sources, ...extra.map(read)];
  }
  const failures = [
    ...relayBoundaryProblems([...sources, ...files.filter(file => /^relay\/.*\.[cm]?js$/u.test(file)).map(read)]).map(row => `${row.file}:${row.line}: ${row.text}`),
    ...importStyleViolations(sources).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`),
    // The approved state metadata chain is proved across the whole tree, so judge the tree and report only changed files.
    ...(staged ? engineFolderViolations(engineSources) : engineFolderProblems(root)).filter(row => files.includes(row.file)).map(row => `${row.file}:${row.line}: ${row.text}`),
  ];
  for (const check of [emptyCatchProblems, fileSizeProblems, testInputProblems]) {
    for (const file of files) {
      const current = check(root, [file], text);
      const baseline = check(root, [file], previous);
      failures.push(...current.slice(baseline.length).map(row => `${row.path}:${row.line}: ${row.text}`));
    }
  }
  failures.push(...loadBearingCheck(root, files, { staged, text, previous }));
  const waitBaseline = JSON.parse(readFileSync(join(root, 'bin/checks/test-waits-baseline.json'), 'utf8'));
  for (const file of files) {
    if (/\.[cm]?js$/u.test(file) && (/(?:^|\/)test\//u.test(file) || /(?:^|\/)(?:test|test[-_.].+|.+[-_.]test)\.[cm]?js$/u.test(file))) {
      const { source } = read(file);
      failures.push(...fixedWallMargins(source, file));
      failures.push(...testWaitGrowth(testWaitSites(source, file), waitBaseline).map(row => `${row.path}:${row.line}: ${row.text}`));
    }
  }
  return failures;
}

/**
 * The load-bearing process check over the changed files: new detached children, unrefs, daemon loops and state files
 * outside the drive, transport, jobs and pin cells, against the ceilings file, which may only fall against main's.
 * A checkout with no ceilings file (a project that is not this repository) has nothing to judge.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {{ staged: boolean, text: (file: string) => string, previous: (file: string) => string }} readers
 * @returns {string[]}
 */
function loadBearingCheck(root, files, { staged, text, previous }) {
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

/** Judge the actual index whenever the explicit staged checker is invoked. */
export function stagedHookFailures(root) {
  const merging = gitSpawnSync(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: root, stdio: 'ignore' }).status === 0;
  const diff = gitSpawnSync(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', ...(merging ? ['MERGE_HEAD'] : [])], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) throw new Error('cannot enumerate staged files');
  return changedStaticFailures(root, diff.stdout.split('\0').filter(Boolean), { staged: true });
}
