/** The gate's changed-file static checks as one function, so the gate and the pre-commit hook run the same list [C7]. */
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runStaticRegistry } from './static-check-registry.js';
import { STATIC_CHECKS } from './static-check-registry.js';
import { gitSpawnSync } from '../../../git/index.js';

/**
 * Judge only the named files with the static checks the gate runs on changed files.
 *
 * @param {string} root - Checkout root the files are read from.
 * @param {string[]} files - Root-relative changed or staged paths.
 * @param {{ staged?: boolean, only?: string[] | null, also?: { name: string, run: (context: object) => string[] }[] }} [options] - `only` runs
 *   just the registered checks with these names; `also` adds checks the caller owns, run on the same context after the registry.
 * @returns {string[]} One `path:line: message` per failure; empty when clean.
 */
export function changedStaticFailures(root, files, { staged = false, only = null, also = [] } = {}) {
  const cache = new Map();
  const accepted = new Map();
  let indexed = null;
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
      if (staged) cache.set(file, (indexed ??= indexReader(root))(file));
      else cache.set(file, readFileSync(join(root, file), 'utf8'));
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
  const context = { root, files, staged, text, previous, read, sources, engineSources };
  const registry = only ? STATIC_CHECKS.filter(check => only.includes(check.name)).flatMap(check => check.run(context)) : runStaticRegistry(context);
  return [...registry, ...also.flatMap(check => check.run(context))];
}

/**
 * A reader of the exact index bytes that spends two Git calls in all: a file whose working copy matches its index entry
 * is read from disk, and only a file that differs, is flagged assume-unchanged or skip-worktree, or is not a regular file
 * is read with `git show`. Why: the whole-tree checks (sync-spawn-in-leases) read hundreds of files, and one Git process
 * per file made the commit hook take 25 s on a loaded machine; reading the index this way gives the same bytes [C7].
 *
 * @param {string} root - Checkout root.
 * @returns {(file: string) => string} Reads one root-relative path as staged; throws when the index has no such file.
 */
function indexReader(root) {
  const listed = gitSpawnSync(['ls-files', '-z', '-v'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const dirty = gitSpawnSync(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0 || dirty.status !== 0) throw new Error('cannot list the index');
  const differs = new Set(dirty.stdout.split('\0').filter(Boolean));
  const plain = new Set(listed.stdout.split('\0').filter(row => row.startsWith('H ')).map(row => row.slice(2)).filter(file => !differs.has(file)));
  return file => {
    if (plain.has(file) && lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()) return readFileSync(join(root, file), 'utf8');
    const result = gitSpawnSync(['show', `:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`cannot read staged ${file}: ${result.stderr || result.error?.message}`);
    return result.stdout;
  };
}

/**
 * Judge the actual index whenever the explicit staged checker is invoked.
 *
 * @param {string} root - Checkout root.
 * @param {{ also?: { name: string, run: (context: object) => string[] }[] }} [options] - Extra staged checks, such as the
 *   test fixture and test-name checks the repository hook adds from bin/checks/changed-static.js.
 * @returns {string[]}
 */
export function stagedHookFailures(root, { also = [] } = {}) {
  const merging = gitSpawnSync(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: root, stdio: 'ignore' }).status === 0;
  const diff = gitSpawnSync(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', ...(merging ? ['MERGE_HEAD'] : [])], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) throw new Error('cannot enumerate staged files');
  return changedStaticFailures(root, diff.stdout.split('\0').filter(Boolean), { staged: true, also });
}
