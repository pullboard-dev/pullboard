/** The gate's changed-file static checks as one function, so the gate and the pre-commit hook run the same list [C7]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runStaticRegistry } from './static-check-registry.js';
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
  return runStaticRegistry({ root, files, staged, text, previous, read, sources, engineSources });
}

/** Judge the actual index whenever the explicit staged checker is invoked. */
export function stagedHookFailures(root) {
  const merging = gitSpawnSync(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: root, stdio: 'ignore' }).status === 0;
  const diff = gitSpawnSync(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', ...(merging ? ['MERGE_HEAD'] : [])], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) throw new Error('cannot enumerate staged files');
  return changedStaticFailures(root, diff.stdout.split('\0').filter(Boolean), { staged: true });
}
