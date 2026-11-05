/**
 * Per-test-file results keyed by their inputs: a green result whose inputs did not change is reused, not run again [C7].
 *
 * A test file's action key hashes the file, its transitive import closure (src/affected-tests.js), the non-JS files it
 * declares or names, bin/run-tests.js, package.json, the Node version and the declared environment. The store sits in
 * the repository's common git dir, so every worktree on the machine shares it, and every write is a rename, so
 * concurrent runs never read half an entry. Only a green result is reused; a red one marks its key for good, since the
 * same inputs once failing makes a later pass a flake. A missing or unreadable entry runs the file.
 *
 * Children record their own outcome as they exit (recordTestAction) into a run folder; the parent run promotes those
 * results once it exits, and for a landing only when the landing itself was green, since a landing can fail a file
 * whose process exited cleanly.
 */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawnSync } from './windows-child-process.js';

export const TEST_ACTIONS_ENV = 'PULLBOARD_TEST_ACTIONS';
export const TEST_STAGE_ENV = 'PULLBOARD_TEST_STAGE';
const VERSION = 1;
const MODULE = /\.[cm]?js$/u;
const RUNNER_INPUTS = ['bin/run-tests.js', 'src/test-action-reporter.js', 'package.json'];
// The environment a test's verdict may depend on; anything else in the environment is per-run noise.
const DECLARED_ENVIRONMENT = ['NODE_OPTIONS', 'PULLBOARD_HOSTED_SHAPES', 'PULLBOARD_TEST_TIMEOUT_MS', 'PULLBOARD_TEST_FILE_TIMEOUT_MS', 'TZ', 'LANG', 'LC_ALL'];
// Options that choose how a run reports or splits files, never what a file proves.
const NEUTRAL_OPTION = /^--(?:test[-_]concurrency|test[-_]reporter(?:[-_]destination)?|test[-_]shard)(?:=|$)/u;
// A run that selects tests inside a file proves only those tests, so it neither reuses nor records.
const FILTER_OPTION = /^--test[-_](?:name|skip)[-_]pattern(?:=|$)|^--test[-_]only$/u;
// Release notes are prose: src reads them for headlines that tests prove against their own fixture copies. A test that
// lists and reads them itself has no key at all (listsOwnCheckout).
const PROSE = new Set(['CHANGELOG.md']);
// Whole trees are inputs only by declaration (`@pullboard-test-input`), never because a fixture names `src`.
const TREE_DECLARATIONS = [['test-tree', ['test/']], ['source-tree', ['src/', 'bin/']], ['docs-tree', ['docs/']]];
// Git commands that read history; a test that declares it reads its own checkout and names one reads that history.
const HISTORY = new Set(['log', 'rev-list', 'shortlog', 'blame', 'reflog', 'whatchanged', 'describe']);
const TOP_TREES = new Set(['', '.', 'src', 'bin', 'test', 'docs']);
const URL_LITERAL = /new\s+URL\(\s*(['"`])([^'"`\\$\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/gu;
const STRING = /(['"])(?:\\[\s\S]|(?!\1)[^\\\r\n])*\1|`(?:\\[\s\S]|[^`\\])*`/uy;

/** Run git in the checkout with a private environment, returning trimmed stdout or throwing its error. */
function git(root, args, env) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || `git ${args[0]} failed`).trim());
  return result.stdout;
}

/** The sha256 of a value's canonical JSON, as hex. */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Write a JSON file by rename, so a concurrent reader sees the old entry, the new one, or none, never half of one. */
function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Every string literal's text, trying each quote as a start, so a quote inside a comment or pattern never hides one. */
function stringLiterals(source) {
  const values = new Set();
  for (const quote of source.matchAll(/['"`]/gu)) {
    STRING.lastIndex = quote.index;
    const match = STRING.exec(source);
    if (match) values.add(match[0].slice(1, -1).split('${', 1)[0]);
  }
  return values;
}

/**
 * The tracked files one module names: for a test-side module (under test/, or the test itself), every file or folder a
 * string names from the root, from the module's folder, or by a file's own name; for any module, every file or folder
 * it opens through new URL('<literal>', import.meta.url). A folder means every file under it, except a whole
 * top-level tree, which counts only by declaration. Over-selection only costs a rerun.
 */
function namedFiles(file, source, testSide, index) {
  const named = new Set();
  /** Add a tracked file, or every file under a tracked folder. */
  const add = (path) => {
    const normal = posix.normalize(path).replace(/\/$/u, '');
    if (normal.startsWith('../') || normal.startsWith('/')) return;
    if (index.files.has(normal)) named.add(normal);
    else if (index.folders.has(normal) && !TOP_TREES.has(normal)) for (const each of index.under(normal)) named.add(each);
  };
  const folder = posix.dirname(file);
  if (testSide) {
    for (const literal of stringLiterals(source)) {
      const value = literal.split(/[?#]/u)[0];
      if (!value || value.length > 300) continue;
      add(value);
      add(posix.join(folder, value));
      for (const path of index.byName.get(value) ?? []) named.add(path);
    }
  }
  for (const match of source.matchAll(URL_LITERAL)) add(posix.join(folder, match[2]));
  return [...named].filter(path => !MODULE.test(path) && !PROSE.has(path));
}

/**
 * True when a module lists the tracked files of its own checkout: a git call naming `ls-files` whose working folder is
 * this checkout, either by default (no cwd) or through an expression built from import.meta or a ROOT constant. A
 * listing in a fixture repository (`cwd: fixture.root`, a helper's own git) is not this checkout's.
 */
function listsOwnCheckout(source) {
  for (const match of source.matchAll(/(['"])ls-files\1/gu)) {
    const start = Math.max(source.lastIndexOf(';', match.index), source.lastIndexOf('\n\n', match.index));
    const end = source.indexOf(';', match.index);
    const statement = source.slice(start + 1, end === -1 ? source.length : end);
    if (!/(['"])git\1/u.test(statement)) continue;
    const cwd = /\bcwd\s*:\s*([^,}]+)/u.exec(statement)?.[1].trim();
    if (!cwd || /import\.meta|\bROOT\b/u.test(cwd)) return true;
    if (/^[A-Za-z_$][\w$]*$/u.test(cwd) && new RegExp(`\\b(?:const|let|var)\\s+${cwd}\\s*=[^;\\n]*(?:import\\.meta|\\bROOT\\b)`, 'u').test(source)) return true;
  }
  return false;
}

/**
 * What a test's closure reads beyond its imports. A declared tree (`@pullboard-test-input`) is read as data, so every
 * file under it counts, JavaScript included: a comment can change a scanner's verdict without changing any import.
 * Every module adds the files it names. A test that declares it reads its own checkout and names `ls-files` reads the
 * list of tracked paths, so that list counts too; one that names a history command reads commits no tree holds, so it
 * has no key and always runs (fail closed). So does a test that lists its own checkout's tracked files without declaring
 * any tree: what it then reads (CHANGELOG.md included) is known to no key.
 *
 * @returns {{ inputs: string[], listing: boolean, history: boolean, undeclaredListing: boolean }}
 */
function declaredReads(test, files, modules, index, helpers = [test]) {
  const inputs = new Set();
  const header = (modules.get(test) ?? '').split(/\r?\n/u);
  let declared = false;
  for (const [name, prefixes] of TREE_DECLARATIONS) {
    if (!header.includes(`/** @pullboard-test-input ${name} */`)) continue;
    declared = true;
    for (const prefix of prefixes) for (const path of index.under(prefix)) inputs.add(path);
  }
  let listing = false, history = false, undeclaredListing = false;
  for (const file of files) {
    const testSide = file.startsWith('test/') || file === test;
    const memo = `${testSide ? 't' : 's'}:${file}`;
    if (!index.named.has(memo)) index.named.set(memo, namedFiles(file, modules.get(file) ?? '', testSide, index));
    for (const path of index.named.get(memo)) inputs.add(path);
    if (!testSide) continue;
    if (!declared) {
      // Only the test and the helpers it reaches directly: a checker that product code imports lists for its caller.
      if (!helpers.includes(file)) continue;
      if (!index.listers.has(file)) index.listers.set(file, listsOwnCheckout(modules.get(file) ?? ''));
      undeclaredListing ||= index.listers.get(file);
      continue;
    }
    if (!index.literals.has(file)) index.literals.set(file, stringLiterals(modules.get(file) ?? ''));
    const literals = index.literals.get(file);
    listing ||= literals.has('ls-files');
    history ||= [...HISTORY].some(command => literals.has(command));
  }
  return { inputs: [...inputs].sort(), listing, history, undeclaredListing };
}

/** Index the tracked tree: every file, every folder, files by their own name, and the files under any folder. */
function treeIndex(blobs) {
  const files = new Set(blobs.keys());
  const byName = new Map();
  const folders = new Set();
  for (const path of files) {
    const name = posix.basename(path);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(path);
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) folders.add(path.slice(0, at));
  }
  const sorted = [...files].sort();
  const cache = new Map();
  /** The tracked files under a folder, sorted; computed once per folder. */
  const under = (folder) => {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    if (!cache.has(prefix)) cache.set(prefix, sorted.filter(path => path.startsWith(prefix)));
    return cache.get(prefix);
  };
  return { files, folders, byName, under, sorted, named: new Map(), literals: new Map(), listers: new Map() };
}

/**
 * Every test file's action key at a commit, or null with a reason when its closure is incomplete. The key hashes the
 * file and its closure, its non-module inputs, the runner and package manifest, Node, the platform, the declared
 * environment and the run's options; the blobs are git object ids, so the key is a pure function of committed bytes.
 *
 * @param {string} root
 * @param {{ commit?: string, options?: string[], env?: NodeJS.ProcessEnv }} [context]
 * @returns {Promise<Map<string, { key: string | null, reason: string }>>}
 */
export async function testActionKeys(root, { commit = 'HEAD', options = [], env = process.env } = {}) {
  const { testClosures } = await import('./affected-tests.js');
  const { closures, modules, blobs } = testClosures(root, commit);
  const index = treeIndex(blobs);
  const shared = {
    version: VERSION,
    runner: RUNNER_INPUTS.map(path => [path, blobs.get(path) ?? null]),
    node: process.version, platform: process.platform, arch: process.arch,
    environment: DECLARED_ENVIRONMENT.map(name => [name, env[name] ?? null]),
    options: options.filter(option => !NEUTRAL_OPTION.test(option)),
  };
  const keys = new Map();
  for (const [test, closure] of closures) {
    if (!closure.files) { keys.set(test, { key: null, reason: closure.reason }); continue; }
    const reads = declaredReads(test, closure.files, modules, index, closure.helpers);
    if (reads.history) { keys.set(test, { key: null, reason: 'it reads the git history of its own checkout' }); continue; }
    if (reads.undeclaredListing) { keys.set(test, { key: null, reason: 'it lists the tracked files of its own checkout without declaring them' }); continue; }
    keys.set(test, { key: digest({ ...shared, test,
      closure: closure.files.map(path => [path, blobs.get(path) ?? null]),
      inputs: reads.inputs.map(path => [path, blobs.get(path)]),
      tracked: reads.listing ? digest(index.sorted) : null }), reason: '' });
  }
  return keys;
}

/** The store folder for this repository, shared by every worktree through the common git dir. */
function storeOf(root, env) {
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env).trim();
  return join(common, 'pullboard', 'test-actions');
}

/**
 * The reusable green entry for a key, or null: a missing, unreadable, mismatched or red-marked entry is never reused.
 *
 * @param {string} store
 * @param {string | null} key
 * @returns {{ key: string, file: string, stage: string, commit: string } | null}
 */
export function reusableResult(store, key) {
  if (!key) return null;
  try { statSync(join(store, 'red', key)); return null; } catch { /* No red mark: the key never failed. */ }
  try {
    const entry = JSON.parse(readFileSync(join(store, 'green', `${key}.json`), 'utf8'));
    return entry?.version === VERSION && entry.key === key && entry.status === 'pass' && typeof entry.commit === 'string' && validTap(entry.tap) ? entry : null;
  } catch { return null; }
}

/** Incomplete reports rerun: an exit status alone cannot reproduce the file's recorded proof. */
function validTap(report) {
  return report && Array.isArray(report.lines) && report.lines.every(line => typeof line === 'string' && /^\s*(?:not )?ok \d+(?: |$)/u.test(line))
    && report.counts && ['passed', 'failed', 'skipped', 'tests'].every(name => Number.isSafeInteger(report.counts[name]) && report.counts[name] >= 0)
    && report.counts.failed === 0 && report.observedTests === report.counts.tests;
}

/**
 * The one rule for whether per-file results, fresh or reused, prove the whole suite: every file of the suite has a
 * result, every result passed, and every reused result was stored under the key the file has now. Pure: it reads
 * nothing but its arguments.
 *
 * @param {string[]} files every test file of the suite
 * @param {Map<string, { status: string, source: 'fresh' | 'reused', key?: string | null, currentKey?: string | null }>} results
 * @returns {{ proven: boolean, missing: string[], failed: string[], stale: string[] }}
 */
export function suiteProven(files, results) {
  const missing = files.filter(file => !results.has(file));
  const failed = files.filter(file => results.has(file) && results.get(file).status !== 'pass');
  const stale = files.filter(file => results.get(file)?.source === 'reused' && (!results.get(file).key || results.get(file).key !== results.get(file).currentKey));
  return { proven: files.length > 0 && !missing.length && !failed.length && !stale.length, missing, failed, stale };
}

/** The repository path of a file selector, or null when it is not a path inside the root. */
function repoPath(root, selector) {
  try {
    const path = relative(root, realpathSync(resolve(root, selector)));
    return path && !path.startsWith('..') ? path.split(sep).join('/') : null;
  } catch { return null; }
}

/** Remove run folders a killed parent never settled, a day after they started. */
function pruneRuns(store) {
  const runs = join(store, 'runs');
  let names = [];
  try { names = readdirSync(runs); } catch { return; }
  for (const name of names) {
    try { if (Date.now() - statSync(join(runs, name)).mtimeMs > 86_400_000) rmSync(join(runs, name), { recursive: true, force: true }); }
    catch { /* A folder another run removed first needs nothing more. */ }
  }
}

/**
 * Decide which selected test files must run. A file whose key has a reusable green result is left out and its receipt
 * says `reused <key> from <stage> <commit>`; when that leaves nothing, the run is done. A checkout that differs from
 * its commit, a filtered run, a selector that is not a tracked test file, or a shard of a planned run keeps every
 * file, and so does any failure to compute keys: reuse is an optimization, never a reason to skip.
 *
 * @param {string} root
 * @param {string[]} args the runner's arguments
 * @param {{ fullSuite: boolean, landing?: boolean, listFiles: () => string[], env?: NodeJS.ProcessEnv, write?: (text: string) => void }} options
 * @returns {Promise<{ args: string[], files: string[] | null, done: boolean }>}
 */
export async function planTestActions(root, args, { fullSuite, landing = false, listFiles, env = process.env, write = text => process.stdout.write(text) }) {
  const keep = { args, files: null, done: false };
  if (env[TEST_ACTIONS_ENV] || env.PULLBOARD_TEST_REUSE === '0' || args.some(arg => FILTER_OPTION.test(arg) || /^--test[-_]reporter(?:[-_]destination)?(?:=|$)/u.test(arg))) return keep;
  let store, commit, keys, selectors;
  try {
    root = realpathSync(root);
    const gitEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
    if (git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], gitEnv)) return keep;
    commit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], gitEnv).trim();
    selectors = listFiles();
    const paths = selectors.map(selector => repoPath(root, selector));
    const fileSet = new Set(selectors);
    keys = await testActionKeys(root, { commit, options: args.filter(arg => !fileSet.has(arg)), env });
    if (!paths.length || paths.some(path => !path || !keys.has(path))) return keep;
    store = storeOf(root, gitEnv);
    selectors = selectors.map((selector, at) => ({ selector, path: paths[at], key: keys.get(paths[at]).key }));
  } catch { return keep; }
  const stage = env[TEST_STAGE_ENV] || (landing ? 'land' : fullSuite ? 'gate' : 'focused');
  const results = new Map();
  const run = [];
  for (const file of selectors) {
    const entry = reusableResult(store, file.key);
    if (!entry) { run.push(file); continue; }
    results.set(file.path, { status: 'pass', source: 'reused', key: entry.key, currentKey: file.key });
    write(`# reused ${entry.key} from ${entry.stage} ${entry.commit} (${file.path})\n`);
    write(`${entry.tap.lines.join('\n')}\n# pass ${entry.tap.counts.passed}\n# fail ${entry.tap.counts.failed}\n# skipped ${entry.tap.counts.skipped}\n`);
  }
  if (!run.length && suiteProven(selectors.map(file => file.path), results).proven) {
    write(`# all ${selectors.length} test files reused; none ran\n`);
    return { args, files: [], done: true };
  }
  const runDir = join(store, 'runs', randomUUID());
  mkdirSync(join(runDir, 'green'), { recursive: true, mode: 0o700 });
  mkdirSync(join(store, 'green'), { recursive: true, mode: 0o700 });
  mkdirSync(join(store, 'red'), { recursive: true, mode: 0o700 });
  pruneRuns(store);
  writeAtomic(join(runDir, 'keys.json'), { root, store, files: Object.fromEntries(run.filter(file => file.key).map(file => [file.path, file.key])) });
  env[TEST_ACTIONS_ENV] = runDir;
  process.once('exit', code => settleTestActions(runDir, { store, stage, commit, landing, code }));
  const reused = new Set(selectors.filter(file => !run.includes(file)).map(file => file.selector));
  if (fullSuite) return { args: [...args, ...run.map(file => file.selector)], files: run.map(file => file.selector), done: false };
  return { args: args.filter(arg => !reused.has(arg)), files: null, done: false };
}

/**
 * Promote the greens a run's children recorded into the shared store, then remove the run folder. A landing that
 * failed promotes nothing: it can fail a file whose own process exited cleanly.
 *
 * @param {string} runDir
 * @param {{ store: string, stage: string, commit: string, landing: boolean, code: number }} run
 */
export function settleTestActions(runDir, { store, stage, commit, landing, code }) {
  try {
    if (!landing || code === 0) {
      for (const name of readdirSync(join(runDir, 'green'))) {
        let staged;
        try { staged = JSON.parse(readFileSync(join(runDir, 'green', name), 'utf8')); } catch { continue; }
        if (typeof staged?.key !== 'string' || !/^[0-9a-f]{64}$/u.test(staged.key)) continue;
        let tap;
        try { tap = JSON.parse(readFileSync(join(runDir, `${digest(staged.file)}.tap.json`), 'utf8')); } catch { continue; }
        if (!validTap(tap)) continue;
        try { statSync(join(store, 'red', staged.key)); continue; } catch { /* Never red: the green may be stored. */ }
        writeAtomic(join(store, 'green', `${staged.key}.json`), { version: VERSION, key: staged.key, file: staged.file,
          status: 'pass', stage, commit, node: process.version, at: new Date().toISOString(), tap });
      }
    }
  } catch (error) {
    process.stderr.write(`run-tests: test results were not stored: ${error.message}\n`);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * In a test file's own process: record its outcome when it exits. Exit 0 stages a green for the parent to promote; any
 * other exit marks the key red at once, so it is never reused. A process killed for a timeout records nothing, so its
 * file runs again. The marker leaves the environment here, so nothing this file starts records as it, and any runner
 * this file starts runs every file it names (a test opts in to reuse by deleting PULLBOARD_TEST_REUSE).
 *
 * @param {string} file the test file's path, as the process received it
 */
export function recordTestAction(file) {
  process.env.PULLBOARD_TEST_REUSE = '0';
  const runDir = process.env[TEST_ACTIONS_ENV];
  delete process.env[TEST_ACTIONS_ENV];
  if (!runDir || process.env.NODE_TEST_CONTEXT !== 'child-v8') return;
  let plan, path;
  try {
    plan = JSON.parse(readFileSync(join(runDir, 'keys.json'), 'utf8'));
    path = relative(plan.root, realpathSync(file)).split(sep).join('/');
  } catch { return; }
  const key = plan.files?.[path];
  if (!key) return;
  process.once('exit', (code) => {
    try {
      if (code === 0) writeAtomic(join(runDir, 'green', `${digest(path)}.json`), { key, file: path });
      else writeAtomic(join(plan.store, 'red', key), { key, file: path, code });
    } catch (error) { process.stderr.write(`run-tests: the result of ${path} was not recorded: ${error.message}\n`); }
  });
}
