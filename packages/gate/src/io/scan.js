/**
 * Shared parts of Pullboard's Rigor checks [D1,C7]: the file walk, a small JavaScript lexer and the
 * report. Each check prints one line per problem as `path:line: text`, sorted by path and line, and
 * exits 0 with no problems or 1 with some, so a doctrine row's `gate: check` can count it and blame
 * a changed file by the repo path at the start of each line.
 *
 * The walk starts at the directory given as the first argument, or the working directory, and skips
 * node_modules, work and every directory whose name starts with a dot (.git among them). Paths are
 * repo-relative with forward slashes, and nothing depends on the order the file system lists them.
 */
import { fileSystemAdapter } from '../../../fs/index.js';
import { readPathMap } from '../../../codemap/light.js';
import { tryGit } from '../../../git/index.js';
import {
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read exact working implementation and compatibility bytes through one committed canonical move identity. */
export function mappedWorkingSources(root, identities) {
  if (!Array.isArray(identities)) throw new Error('working source identities must be explicit');
  for (const identity of identities) if (typeof identity !== 'string' || !identity || /[\\:\x00-\x1f\x7f]/u.test(identity)
    || identity.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid working source identity');
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.status !== 0) throw new Error('working source needs an exact committed map');
  const commit = head.stdout.trim();
  const mapPaths = ['path-map.json', 'packages/codemap/data/plan/path-map'];
  /** A dirty or untracked mapping cannot silently describe another working implementation. */
  function cleanMap() {
    const status = tryGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...mapPaths]);
    if (status.status !== 0 || status.stdout) throw new Error('working source map is stale or uncommitted');
  }
  cleanMap();
  const map = readPathMap(root, { commit });
  const canonicalRoot = fs.realpath(root);
  /** Preserve actual Buffer bytes and reject missing, symbolic or escaping implementation paths. */
  function bytes(file, optional = false) {
    const path = join(canonicalRoot, file);
    let stat;
    try { stat = fs.lstat(path); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    const canonical = fs.realpath(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !canonical.startsWith(canonicalRoot + sep)) {
      throw new Error('working source must be a contained regular file');
    }
    return fs.readFile(path, null);
  }
  const result = identities.map(identity => {
    const implementationPath = map.get(identity) ?? identity;
    const body = bytes(implementationPath);
    const shimPath = implementationPath === identity ? null : identity;
    const shimBody = shimPath ? bytes(shimPath, true) : null;
    return Object.freeze({ commit, identity, implementationPath, body, shimPath, shimBody });
  });
  cleanMap();
  const after = tryGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (after.status !== 0 || after.stdout.trim() !== commit) throw new Error('working source map changed during its read');
  return result;
}

/** Read one explicit mapped identity with the same exact byte and containment checks. */
export function mappedWorkingSource(root, identity) {
  return mappedWorkingSources(root, [identity])[0];
}

/** The root a check scans: its first argument, else the working directory. */
export function rootOf(argv = process.argv) {
  return resolve(argv[2] ?? process.cwd());
}

/**
 * Run a check and report when its file is the program Node started; importing it runs nothing.
 * Why: the test imports each check, so the affected-test selection sees an import edge to it.
 *
 * @param {ImportMeta} meta - the check's `import.meta`
 * @param {(root: string) => { path: string, line: number, text: string }[]} find
 */
export function runCheck(meta, find) {
  // Node resolves symlinks in a module's URL but not in argv, so compare real paths.
  if (process.argv[1] && fs.exists(process.argv[1]) && fs.realpath(process.argv[1]) === fs.realpath(fileURLToPath(meta.url))) report(find(rootOf()));
}

/** Preserve every selected working source file, including both compatibility shims and their mapped bodies. */
export function workingSourceInventory(root, directories) {
  if (!Array.isArray(directories) || !directories.length) throw new Error('working source directories must be explicit');
  const canonicalRoot = fs.realpath(root);
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.status !== 0) throw new Error('working source inventory needs a committed map');
  const commit = head.stdout.trim(), map = readPathMap(root, { commit });
  const identities = new Set(), selected = new Set();
  for (const directory of directories) {
    if (typeof directory !== 'string' || !directory || /[\\:\x00-\x1f\x7f]/u.test(directory)
      || directory.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid working source directory');
    const path = join(canonicalRoot, directory), stat = fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !fs.realpath(path).startsWith(canonicalRoot + sep)) {
      throw new Error('working source directory must be contained and regular');
    }
    selected.add(directory);
    for (const name of fs.list(path)) if (name.endsWith('.js')) identities.add(directory + '/' + name);
  }
  // A private old source may have no shim. Its committed identity still belongs to this original directory scan.
  for (const from of map.keys()) if (from.endsWith('.js') && selected.has(from.slice(0, from.lastIndexOf('/')))) identities.add(from);
  const rows = mappedWorkingSources(canonicalRoot, [...identities]);
  if (rows.some(row => row.commit !== commit)) throw new Error('working source map changed during its inventory');
  const files = new Map();
  /** Keep actual Buffer bytes once per physical path; duplicate aliases cannot hide an inconsistent read. */
  function add(file, body) {
    if (files.has(file) && !files.get(file).body.equals(body)) throw new Error('working source changed during its inventory');
    if (!files.has(file)) files.set(file, Object.freeze({ file, body }));
  }
  for (const row of rows) {
    if (row.shimPath && row.shimBody !== null) add(row.shimPath, row.shimBody);
    add(row.implementationPath, row.body);
  }
  return [...files.values()];
}

/**
 * Print problems sorted by path, then line number, then text, and set the exit status: 0 with no
 * problems, 1 with some. One line each, as `path:line: text`.
 *
 * @param {{ path: string, line: number, text: string }[]} problems
 */
export function report(problems) {
  const sorted = [...problems].sort((a, b) => byText(a.path, b.path) || a.line - b.line || byText(a.text, b.text));
  if (sorted.length) process.stdout.write(sorted.map((problem) => `${problem.path}:${problem.line}: ${problem.text}\n`).join(''));
  process.exitCode = sorted.length ? 1 : 0;
}

export {
  lex,
  lineAt,
} from '../../../kernel/index.js';

export {
  narrowedTo,
  readText,
  TEST_FILE,
  walk,
} from '../../../codemap/light.js';

const fs = fileSystemAdapter();

/** Compare by UTF-16 code units, so the order never depends on the machine's locale. */
function byText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
