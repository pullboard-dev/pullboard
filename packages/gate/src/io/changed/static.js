/** The gate's changed-file static checks as one function, so the gate and the pre-commit hook run the same list [C7]. */
import { join } from 'node:path';
import { runStaticRegistry } from '../static/check/registry.js';
import { STATIC_CHECKS } from '../static/check/registry.js';
import { gitSpawnSync } from '../../../../git/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

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
  let aliases = null;
  let mainPaths = null;
  /** Main's text of one path, or null when main has no such file. */
  const mainText = file => {
    if (mainPaths === null) {
      const listed = gitSpawnSync(['ls-tree', '-r', '-z', '--name-only', 'refs/heads/main'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (listed.error) throw listed.error;
      if (listed.status !== 0) throw new Error(`cannot list accepted static sources: ${listed.stderr}`);
      mainPaths = new Set(listed.stdout.split('\0').filter(Boolean));
    }
    if (!mainPaths.has(file)) return null;
    const result = gitSpawnSync(['show', `refs/heads/main:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout;
    throw new Error(`cannot read accepted static source ${file}: ${result.stderr}`);
  };
  /**
   * Existing debt is read from accepted main, never the candidate working tree or a baseline file. A file main lacks is
   * read at the older paths the candidate's path map moved into it, so a moved file keeps its debt and a merged file the
   * sum of its parts: findings follow renames [V24,V32]. A file with no history reads as empty.
   */
  const previous = file => {
    if (!accepted.has(file)) {
      let text = mainText(file);
      // Source only: a ceiling or baseline file is keyed by path, and the move already rewrote its keys.
      if (text === null && /\.(?:[cm]?js|css)$/u.test(file)) {
        aliases ??= movedFrom(root, staged ? (indexed ??= indexReader(root)) : null);
        text = (aliases.get(file) ?? []).map(mainText).filter(old => old !== null).join('\n');
      }
      accepted.set(file, text ?? '');
    }
    return accepted.get(file);
  };
  /** Read each exact candidate source once, from the index for a commit hook. */
  const text = file => {
    if (!cache.has(file)) {
      if (staged) cache.set(file, (indexed ??= indexReader(root))(file));
      else cache.set(file, fs.readFile(join(root, file), 'utf8'));
    }
    return cache.get(file);
  };
  /** Bind each checker row to its root-relative path and exact candidate bytes. */
  const read = file => ({ file, source: text(file) });
  const sources = files.filter(file => /^(?:src|packages|apps)\//u.test(file) && /\.[cm]?js$/u.test(file)).map(read);
  let engineSources = sources;
  // A file forwarding an engine through a state front door is judged against those doors and the leaves they name.
  if (staged && sources.some(row => /_ENGINE\b/u.test(row.source))) {
    const paths = gitSpawnSync(['ls-files', '-z', '--', 'packages/state/index.js', 'packages/state/light.js', 'packages/state/src/logic'], { cwd: root, encoding: 'utf8' });
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
    if (plain.has(file) && fs.lstat(join(root, file), { throwIfNoEntry: false })?.isFile()) return fs.readFile(join(root, file), 'utf8');
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
 *   test fixture and test-name checks the repository hook adds from packages/gate/src/io/changed/scripts/static.js.
 * @returns {string[]}
 */
export function stagedHookFailures(root, { also = [] } = {}) {
  const merging = gitSpawnSync(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: root, stdio: 'ignore' }).status === 0;
  const diff = gitSpawnSync(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', ...(merging ? ['MERGE_HEAD'] : [])], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) throw new Error('cannot enumerate staged files');
  return changedStaticFailures(root, diff.stdout.split('\0').filter(Boolean), { staged: true, also });
}

/**
 * New path to every older path the candidate's path map moves into it, through chains of moves. Read from the index for a
 * commit hook, else the working tree; an unreadable shard adds nothing, so a missing alias only reads as new code.
 * Why the index reader: one `git show` per shard was 46 Git processes, most of a 20-file hook's 2 s on a slow runner [C7].
 *
 * @param {string} root - Checkout root.
 * @param {((file: string) => string) | null} staged - The index reader for a commit hook; null reads the working tree.
 * @returns {Map<string, string[]>}
 */
function movedFrom(root, staged) {
  const folder = 'packages/codemap/data/plan/path-map';
  const listed = gitSpawnSync(['ls-files', '-z', '--', folder], { cwd: root, encoding: 'utf8' });
  const map = new Map();
  for (const shard of (listed.status === 0 ? listed.stdout : '').split('\0').filter(name => name.endsWith('.json'))) {
    let data;
    try {
      data = JSON.parse(staged ? staged(shard) : fs.readFile(join(root, shard), 'utf8'));
    } catch { continue; } // an unreadable shard maps nothing
    if (data && typeof data === 'object' && !Array.isArray(data)) for (const [from, to] of Object.entries(data)) if (typeof to === 'string') map.set(from, to);
  }
  const into = new Map();
  for (const from of map.keys()) {
    let path = from;
    for (const seen = new Set(); map.has(path) && !seen.has(path);) { seen.add(path); path = map.get(path); }
    if (path !== from) into.set(path, [...(into.get(path) ?? []), from]);
  }
  return into;
}
