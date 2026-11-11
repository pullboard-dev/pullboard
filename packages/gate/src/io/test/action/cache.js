/**
 * Per-test-file results keyed by their inputs: a green result whose inputs did not change is reused, not run again [C7].
 *
 * A test file's action key hashes the file, its transitive import closure (src/affected-tests.js), the non-JS files it
 * declares or names, apps/cli/src/io/run/tests.js, package.json, the Node version and the declared environment. The store sits in
 * the repository's common git dir, so every worktree on the machine shares it, and every write is a rename, so
 * concurrent runs never read half an entry. Only a green result is reused; a red one marks its key for good, since the
 * same inputs once failing makes a later pass a flake. A missing or unreadable entry runs the file.
 *
 * Children record their own outcome as they exit (recordTestAction) into a run folder; the parent run promotes those
 * results once it exits, and for a landing only when the landing itself was green, since a landing can fail a file
 * whose process exited cleanly.
 */
import { maintainPartsStore } from './prune.js';
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
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import { memoizedActionKeys } from './memo.js';
import {
  firstChangedInput,
  formatCacheRows,
  latestKey,
  recordInputParts,
  rememberLatest,
} from '../account.js';
import { hostname } from 'node:os';
import {
  TEST_RESULT_ORIGIN_ENV,
  TEST_RESULT_REQUEST_ENV,
  completedTestResult,
  TEST_RESULT_STORE_ENV,
  TEST_RESULT_VERSION,
  storeTestResult,
  selectedTestResults,
  validTestResult,
  validTestTap,
  testResultOutcomes,
} from '../store.js';

export const TEST_ACTIONS_ENV = 'PULLBOARD_TEST_ACTIONS';
export const TEST_STAGE_ENV = 'PULLBOARD_TEST_STAGE';
// PULLBOARD_TEST_REUSE=record: run every file, never consult a stored green, but record each green (a census or main
// comparison is a fresh sample that still feeds the store). =0 neither consults nor records.
export const TEST_REUSE_RECORD = 'record';
export const RECORD_ONLY_PREFIX = `PULLBOARD_TEST_REUSE=${TEST_REUSE_RECORD}`;
const VERSION = TEST_RESULT_VERSION;
const MODULE = /\.[cm]?js$/u;
const RUNNER_INPUTS = ['apps/cli/src/io/run/tests.js', 'packages/gate/src/io/run-tests.js', 'packages/gate/src/io/run-tests-watchdog-source.js', 'packages/gate/src/io/test/action/reporter.js', 'package.json'];
// The environment a test's verdict may depend on; anything else in the environment is per-run noise.
const DECLARED_ENVIRONMENT = ['NODE_OPTIONS', 'PULLBOARD_HOSTED_SHAPES', 'PULLBOARD_TEST_TIMEOUT_MS', 'PULLBOARD_TEST_FILE_TIMEOUT_MS', 'PULLBOARD_TEST_REAL', 'PULLBOARD_ADAPTER_AUDIT', 'TZ', 'LANG', 'LC_ALL'];
// Options that choose how a run reports or splits files, never what a file proves.
const NEUTRAL_OPTION = /^--(?:test[-_]concurrency|test[-_]reporter(?:[-_]destination)?|test[-_]shard)(?:=|$)/u;
// Release notes are prose: src reads them for headlines that tests prove against their own fixture copies. A test that
// lists and reads them itself has no key at all (listsOwnCheckout).
const PROSE = new Set(['CHANGELOG.md']);
// Whole trees are inputs only by declaration (`@pullboard-test-input`), never because a fixture names `src`.
// Tests live in a cell's tests/ folder and, for an app, its journeys/ folder; the source tree is the rest of apps/ and
// packages/: each cell's src/ and its doors (index.js, light.js, browser.js), data and fixtures included.
export const TEST_SIDE_PATH = /^(?:packages\/[^/]+\/tests|apps\/[^/]+\/(?:tests|journeys))\//u;
export const TREE_DECLARATIONS = [['test-tree', path => TEST_SIDE_PATH.test(path)],
  ['source-tree', path => /^(?:apps|packages)\//u.test(path) && !TEST_SIDE_PATH.test(path)], ['docs-tree', path => path.startsWith('docs/')]];
// The analyzer's own files, relative to this module; their bytes are part of every key.
export const ANALYZER_FILES = ['cache.js', 'memo.js', '../store.js', '../../affected/tests.js', '../../affected/graph/cache.js', '../../../../../codemap/src/io/main-facts-cache.js', '../../../../../codemap/src/logic/imports.js', '../../../../../codemap/src/io/module/imports.js'];
// Git commands that read history; a test that declares it reads its own checkout and names one reads that history.
const HISTORY = new Set(['log', 'rev-list', 'shortlog', 'blame', 'reflog', 'whatchanged', 'describe']);
const TOP_TREES = new Set(['', '.', 'apps', 'packages', 'docs']);
const URL_LITERAL = /new\s+URL\(\s*(['"`])([^'"`\\$\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/gu;
const STRING = /(['"])(?:\\[\s\S]|(?!\1)[^\\\r\n])*\1|`(?:\\[\s\S]|[^`\\])*`/uy;

/** Remove only scheduling/reporting options, including their separate values, from proof identity. */
function materialOptions(options) {
  const selected = [];
  for (let at = 0; at < options.length; at++) {
    if (!NEUTRAL_OPTION.test(options[at])) selected.push(options[at]);
    else if (!options[at].includes('=') && options[at + 1] && !options[at + 1].startsWith('--')) at++;
  }
  return selected;
}

/** Bind actual execution inputs; the runner's exact private custody preload is per-job noise. */
function executionContext(env) {
  return { node: process.version, platform: process.platform, arch: process.arch,
    environment: [...DECLARED_ENVIRONMENT, 'PULLBOARD_TEST_CACHE_TOOLING'].map(name => [name,
      name === 'NODE_OPTIONS' && env.PULLBOARD_RUNNER_PRELOAD && env[name] === env.PULLBOARD_RUNNER_PRELOAD
        ? null : env[name] ?? null]) };
}

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
export function declaredReads(test, files, modules, index, helpers = [test]) {
  const inputs = new Set();
  const header = (modules.get(test) ?? '').split(/\r?\n/u);
  let declared = false;
  for (const [name, inTree] of TREE_DECLARATIONS) {
    if (!header.includes(`/** @pullboard-test-input ${name} */`)) continue;
    declared = true;
    if (!index.trees.has(name)) index.trees.set(name, index.sorted.filter(inTree));
    for (const path of index.trees.get(name)) inputs.add(path);
  }
  let listing = false, history = false, undeclaredListing = false;
  for (const file of files) {
    const testSide = TEST_SIDE_PATH.test(file) || file === test;
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
export function treeIndex(blobs) {
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
  return { files, folders, byName, under, sorted, named: new Map(), trees: new Map(), literals: new Map(), listers: new Map() };
}

/**
 * Every test file's action key at a commit, or null with a reason when its closure is incomplete. The key hashes the
 * file and its closure, its non-module inputs, the runner and package manifest, Node, the platform, the declared
 * environment and the run's options; the blobs are git object ids, so the key is a pure function of committed bytes.
 *
 * @param {string} root
 * Why `maintain`: the store's upkeep (the parts prune and the memo age sweep) reads every key memo and result record,
 * 184,000 files and 733 MB on the coordinator on 9 Nov; run inside a runner dispatch's request it held that dispatch for
 * minutes and loaded the disk under every other dispatch. A dispatch passes false; other callers keep the upkeep.
 *
 * @param {string} root
 * @param {{ commit?: string, options?: string[], env?: NodeJS.ProcessEnv, files?: string[], maintain?: boolean }} [context]
 * @returns {Promise<Map<string, { key: string | null, reason: string }>>}
 */
export async function testActionKeys(root, { commit = 'HEAD', options = [], env = process.env, files, maintain = true } = {}) {
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
  const shared = {
    version: VERSION,
    options: materialOptions(options),
  };
  const context = executionContext(env);
  // Hash the executing analyzer as well as the committed tree: fixture and installed tooling
  // can live outside that tree, and a new analyzer must not read an older algorithm's memo.
  const analyzer = ANALYZER_FILES
    .map(file => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]);
  shared.policy = digest(analyzer);
  const identity = digest({ ...shared, context, tree: git(root, ['rev-parse', `${commit}^{tree}`], gitEnv).trim(), analyzer });
  const store = testResultStore(root, gitEnv);
  // Store upkeep reads every key memo and result record; a runner dispatch never pays it (maintain: false) [C7].
  if (maintain) maintainPartsStore(store, env);
  return memoizedActionKeys(store, identity, files, async () => {
  const { testClosures } = await import('../../affected/tests.js');
  const { closures, modules, blobs, reach } = testClosures(root, commit);
  const index = treeIndex(blobs);
  // A test runs inside the harness, so everything the harness reaches (its isolation, dispatch, admission
  // and reporting modules) is an input of every result, as well as the runner files themselves.
  // Test files and docs the graph links through declared tree reads are never harness code, so they stay out.
  const harness = reach(RUNNER_INPUTS, { withoutSelectedRunnerModules: true }).filter(path => !TEST_SIDE_PATH.test(path) && !path.startsWith('docs/'));
  const runner = [...new Set([...RUNNER_INPUTS, ...harness])].sort().map(path => [path, blobs.get(path) ?? null]);
  const keys = new Map();
  for (const [test, closure] of closures) {
    if (!closure.files) { keys.set(test, { key: null, reason: closure.reason }); continue; }
    const reads = declaredReads(test, closure.files, modules, index, closure.helpers);
    if (reads.history) { keys.set(test, { key: null, reason: 'it reads the git history of its own checkout' }); continue; }
    if (reads.undeclaredListing) { keys.set(test, { key: null, reason: 'it lists the tracked files of its own checkout without declaring them' }); continue; }
    const inputKey = digest({ ...shared, runner, test,
      closure: closure.files.map(path => [path, blobs.get(path) ?? null]),
      inputs: reads.inputs.map(path => [path, blobs.get(path)]),
      tracked: reads.listing ? digest(index.sorted) : null });
    recordInputParts(store, inputKey, { test, files: closureBlobs(closure.files, blobs), runner, inputs: reads.inputs.map(path => [path, blobs.get(path)]),
      tracked: reads.listing ? digest(index.sorted) : null, options: shared.options });
    keys.set(test, { inputKey, context, key: digest({ inputKey, context }), reason: '' });
  }
  return keys;
  }, { prune: maintain });
}

/** The store folder for this repository, shared by every worktree through the common git dir. */
export function testResultStore(root, env = process.env) {
  if (env[TEST_RESULT_STORE_ENV] && isAbsolute(env[TEST_RESULT_STORE_ENV])) return env[TEST_RESULT_STORE_ENV];
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
    return validTestResult(entry) && entry.key === key && entry.status === 'pass' ? entry : null;
  } catch { return null; }
}

/** Incomplete reports rerun: an exit status alone cannot reproduce the file's recorded proof. */
function validTap(report) { return validTestTap(report); }

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
 * its commit, a selector that is not a tracked test file, or a shard of a planned run keeps every
 * file, and so does any failure to compute keys: reuse is an optimization, never a reason to skip.
 *
 * @param {string} root
 * @param {string[]} args the runner's arguments
 * @param {{ fullSuite: boolean, landing?: boolean, listFiles: () => string[], env?: NodeJS.ProcessEnv, write?: (text: string) => void }} options
 * @returns {Promise<{ args: string[], files: string[] | null, done: boolean }>}
 */
export async function planTestActions(root, args, { fullSuite, landing = false, listFiles, env = process.env, write = text => process.stdout.write(text) }) {
  const keep = { args, files: null, done: false };
  const recordOnly = env.PULLBOARD_TEST_REUSE === TEST_REUSE_RECORD;
  // Selection options remain in the action key: a partial proof cannot stand in for a whole file.
  if (env[TEST_ACTIONS_ENV] || env.PULLBOARD_TEST_REUSE === '0' || args.some(arg => /^--test[-_]reporter(?:[-_]destination)?(?:=|$)/u.test(arg))) return keep;
  let store, commit, keys, selectors;
  try {
    root = realpathSync(root);
    const gitEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
    if (git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], gitEnv)) return keep;
    commit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], gitEnv).trim();
    selectors = listFiles();
    const paths = selectors.map(selector => repoPath(root, selector));
    const fileSet = new Set(selectors);
    keys = await testActionKeys(root, { commit, options: args.filter(arg => !fileSet.has(arg)), env, files: paths });
    if (!paths.length || paths.some(path => !path || !keys.has(path))) return keep;
    store = testResultStore(root, gitEnv);
    selectors = selectors.map((selector, at) => ({ selector, path: paths[at], ...keys.get(paths[at]) }));
  } catch { return keep; }
  const stage = env[TEST_STAGE_ENV] || (landing ? 'land' : fullSuite ? 'gate' : 'focused');
  const results = new Map();
  const account = [];
  const reusedTestOutcomes = [];
  const run = [];
  for (const file of selectors) {
    const entry = recordOnly ? null : reusableResult(store, file.key);
    const outcomes = entry && testResultOutcomes(entry);
    if (!entry || !outcomes || entry.file !== file.path || entry.inputKey !== file.inputKey
      || env[TEST_RESULT_REQUEST_ENV] && !completedTestResult(entry)) { run.push(file); account.push(ranAccount(store, file)); continue; }
    account.push(reusedAccount(store, file));
    reusedTestOutcomes.push(...outcomes);
    results.set(file.path, { status: 'pass', source: 'reused', key: entry.key, currentKey: file.key });
    write(`# reused ${entry.key} from ${entry.stage} ${entry.commit} (${file.path})\n`);
    write(`# result-origin ${JSON.stringify(entry.origin)}\n`);
    write(`${entry.tap.lines.join('\n')}\n# pass ${entry.tap.counts.passed}\n# fail ${entry.tap.counts.failed}\n# skipped ${entry.tap.counts.skipped}\n`);
  }
  write(formatCacheRows(account));
  if (!run.length && suiteProven(selectors.map(file => file.path), results).proven) {
    write(`# all ${selectors.length} test files reused; none ran\n`);
    return { args, files: [], done: true, reusedTestOutcomes };
  }
  const runDir = join(store, 'runs', randomUUID());
  mkdirSync(join(runDir, 'green'), { recursive: true, mode: 0o700 });
  mkdirSync(join(store, 'green'), { recursive: true, mode: 0o700 });
  mkdirSync(join(store, 'red'), { recursive: true, mode: 0o700 });
  pruneRuns(store);
  writeAtomic(join(runDir, 'keys.json'), { root, store, stage, commit,
    request: env[TEST_RESULT_REQUEST_ENV] ?? null,
    machine: env[TEST_RESULT_ORIGIN_ENV] || `local-${digest(hostname()).slice(0, 16)}`,
    inputs: Object.fromEntries(run.filter(file => file.key).map(file => [file.path, { inputKey: file.inputKey, context: file.context }])),
    files: Object.fromEntries(run.filter(file => file.key).map(file => [file.path, file.key])) });
  env[TEST_ACTIONS_ENV] = runDir;
  process.once('exit', code => settleTestActions(runDir, { store, stage, commit, landing, code }));
  const reused = new Set(selectors.filter(file => !run.includes(file)).map(file => file.selector));
  if (fullSuite) return { args: [...args, ...run.map(file => file.selector)], files: run.map(file => file.selector), done: false, reusedTestOutcomes };
  return { args: args.filter(arg => !reused.has(arg)), files: null, done: false, reusedTestOutcomes };
}

/**
 * Before any queueing: which of these test files already have a recorded green under the same inputs, and which must
 * run. A file is reused when its input key (import closure and inputs at `commit`) has a stored pass that a runner
 * completed under the runner's own context (declared environment TZ=UTC, LANG=C and `tooling`, the sha of the
 * tooling the runner executes), has full TAP outcomes and no red mark. A file with no key, no such green or a read
 * error runs: reuse is an optimization, never a reason to skip. Pass `runtimes` ({ node, platform, arch } rows) to
 * accept only greens from those runtimes; omitted, a green from any runner runtime counts.
 *
 * Why: the runner reuses after the file already queued and a slot was held; a commit that changes one test's key
 * still waited for all 1,586 (10 Nov). The census never consults this (PULLBOARD_TEST_REUSE=record).
 *
 * @param {string} root
 * @param {string} commit
 * @param {string[]} files repository paths of test files
 * @param {string} tooling the runner tooling sha256 (spec.tooling.sha256)
 * @param {{ env?: NodeJS.ProcessEnv, runtimes?: Array<{ node: string, platform: string, arch: string }> | null }} [options]
 * @returns {Promise<{ reused: Map<string, { entry: object, key: string }>, run: string[] }>}
 */
export async function preQueueReuse(root, commit, files, tooling, { env = process.env, runtimes = null } = {}) {
  const reused = new Map();
  const everything = { reused, run: [...files] };
  if (!/^[0-9a-f]{64}$/u.test(tooling ?? '') || !files.length || env.PULLBOARD_TEST_REUSE === '0' || env[TEST_ACTIONS_ENV]) return everything;
  try {
    const runnerEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !DECLARED_ENVIRONMENT.includes(name) && name !== 'PULLBOARD_TEST_CACHE_TOOLING'));
    Object.assign(runnerEnv, { TZ: 'UTC', LANG: 'C', PULLBOARD_TEST_CACHE_TOOLING: tooling });
    const expected = JSON.stringify(executionContext(runnerEnv).environment);
    const gitEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
    const keys = await testActionKeys(root, { commit, env: runnerEnv, files, maintain: false });
    const store = testResultStore(root, gitEnv);
    for (const file of files) {
      const inputKey = keys.get(file)?.inputKey;
      if (!inputKey) continue;
      for (const candidate of selectedTestResults(store, [inputKey])) {
        if (candidate.status !== 'pass' || candidate.file !== file || !completedTestResult(candidate)
          || JSON.stringify(candidate.context.environment) !== expected
          || runtimes && !runtimes.some(row => row.node === candidate.context.node && row.platform === candidate.context.platform && row.arch === candidate.context.arch)) continue;
        const entry = reusableResult(store, candidate.key);
        if (!entry || entry.inputKey !== inputKey || !testResultOutcomes(entry)) continue;
        reused.set(file, { entry, key: entry.key });
        break;
      }
    }
  } catch { return everything; }
  return { reused, run: files.filter(file => !reused.has(file)) };
}

/** The receipt text for reused files: each file's key line, and its stored TAP when `tap` is set. */
export function reuseReceipt(reused, { tap = false } = {}) {
  return [...reused].map(([file, { entry, key }]) => `# reused ${key} from ${entry.stage} ${entry.commit} (${file})\n`
    + (tap ? `${entry.tap.lines.join('\n')}\n# pass ${entry.tap.counts.passed}\n# fail ${entry.tap.counts.failed}\n# skipped ${entry.tap.counts.skipped}\n` : '')).join('');
}

/** The [path, blob] pairs of a closure. */
function closureBlobs(files, blobs) { return files.map(path => [path, blobs.get(path) ?? null]); }

/** A file's row when it must run: its key, and which input changed since its last key (or why it has no key). */
function ranAccount(store, file) {
  const missed = file.key ? firstChangedInput(store, latestKey(store, file.path), file) : `no key: ${file.reason}`;
  if (file.key) rememberLatest(store, file.path, { key: file.key, inputKey: file.inputKey, context: file.context });
  return { file: file.path, outcome: 'ran', key: file.key ?? null, missed };
}

/** A file's row when its cached green is reused; the key becomes its latest. */
function reusedAccount(store, file) {
  rememberLatest(store, file.path, { key: file.key, inputKey: file.inputKey, context: file.context });
  return { file: file.path, outcome: 'reused', key: file.key, missed: null };
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
    const plan = JSON.parse(readFileSync(join(runDir, 'keys.json'), 'utf8'));
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const unchanged = git(plan.root, ['rev-parse', 'HEAD'], gitEnv).trim() === commit
      && !git(plan.root, ['status', '--porcelain', '-z', '--untracked-files=all'], gitEnv);
    if (unchanged && (!landing || code === 0)) {
      for (const name of readdirSync(join(runDir, 'green'))) {
        let staged;
        try { staged = JSON.parse(readFileSync(join(runDir, 'green', name), 'utf8')); } catch { continue; }
        if (typeof staged?.key !== 'string' || !/^[0-9a-f]{64}$/u.test(staged.key)) continue;
        let tap;
        try { tap = JSON.parse(readFileSync(join(runDir, `${digest(staged.file)}.tap.json`), 'utf8')); } catch { continue; }
        if (!validTap(tap)) continue;
        try { statSync(join(store, 'red', staged.key)); continue; } catch { /* Never red: the green may be stored. */ }
        const at = new Date().toISOString();
        storeTestResult(store, { version: VERSION, key: staged.key, file: staged.file, ...plan.inputs[staged.file],
          status: 'pass', stage, commit, node: process.version, at, tap,
          origin: { machine: plan.machine, stage, commit, at, ...(plan.request ? { request: plan.request } : {}) } });
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
  // A test's own fixture runners must not read or write the enclosing fleet job's cache.
  delete process.env[TEST_RESULT_STORE_ENV];
  delete process.env[TEST_RESULT_ORIGIN_ENV];
  delete process.env[TEST_RESULT_REQUEST_ENV];
  delete process.env.PULLBOARD_TEST_CACHE_TOOLING;
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
      else {
        const at = new Date().toISOString();
        storeTestResult(plan.store, { version: VERSION, key, file: path, ...plan.inputs[path], status: 'fail', code,
          stage: plan.stage, commit: plan.commit, at,
          origin: { machine: plan.machine, stage: plan.stage, commit: plan.commit, at, ...(plan.request ? { request: plan.request } : {}) } });
      }
    } catch (error) { process.stderr.write(`run-tests: the result of ${path} was not recorded: ${error.message}\n`); }
  });
}
