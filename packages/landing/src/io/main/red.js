/** Fresh per-file main comparisons for inherited submit reds [V1]. */
import { environmentAdapter } from '../../../../env/index.js';
import { testClosures } from '../../../../gate/index.js';
import { testActionKeys } from '../../../../gate/index.js';
import { selectAffectedTests } from '../../../../gate/index.js';
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
import { checkoutCommonDir } from '../../../../git/index.js';
import { commandFact } from '../../../../git/index.js';
import { gitSpawnSync } from '../../../../git/index.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  withGateSlot,
} from '../../../../gate/index.js';
import { runMainComparison } from '../../../../gate/index.js';
import { whileGateRuns } from '../../../../gate/index.js';
import { runProfiledShellAsync } from '../../../../gate/index.js';
import {
  readGateReceipt,
  receiptBody,
  receiptStore,
} from '../../../../gate/index.js';
import {
  cleanGitEnvironment,
  mainCheckout,
} from '../../../../git/index.js';
import {
  mainPolicy,
  policyAt,
} from '../../../../sandbox/index.js';
import { parseSpec } from '../../../../spec/index.js';
import { listItems } from '../../../../store/index.js';
import {
  takeResource,
  requiredExecutorOf,
} from '../../../../resources/index.js';
import { withEnvironment } from '../../../../resources/index.js';
import { sameEnvironment } from '../../../../verify/light.js';
import { Refused } from '../../../../kernel/index.js';
import {
  matchingMainFailures,
  failureSignatures,
  cachedFailureSignatures,
  MAIN_FAILURE_SIGNATURE_VERSION,
} from './matches.js';
import { completeGate } from '../completion.js';
import { linkKnownMainReworks } from '../../../../store/index.js';
import { testsNeedBrowser } from '../../../../gate/index.js';
import { testsNeedGui } from '../../../../gate/index.js';
import { browserFreeChecksEnabled } from '../../../../config/index.js';
import { loadMachineSettings } from '../../../../config/index.js';
import { gateRunnerAdmission } from '../../../../config/index.js';
import { recentReceipts } from '../../../../gate/index.js';
import { scratchFolder } from '../../../../config/index.js';
import { scratchRoot } from '../../../../config/index.js';
import { storeName } from '../store-names.js';

/** The environment this file reads, through the one adapter [C7]. */
const environment = environmentAdapter();

const CACHE_RELATIVE = 'pullboard/main-red.json';
// Version 2 drops results cached while comparisons ran in a checkout without accepted main (#2950).
const CACHE_VERSION = 2;

/** Resolve one test filename from runner output to a safe repository-relative path. */
function testPath(root, value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('file:')) {
    try { value = fileURLToPath(value); } catch { return null; }
  }
  const absolute = resolve(root, value);
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || path.startsWith(sep)) return null;
  return path.split(sep).join('/');
}

/** Unique failed files named by TAP/JUnit metadata or Node's native spec failure footer. */
export function failingFiles(root, profile, output) {
  const files = new Set();
  for (const test of profile?.tests ?? []) if (test.passed === false) {
    const path = testPath(root, test.file);
    if (path) files.add(path);
  }
  // TAP file rows represent crashes; JUnit suite rows include passing files too.
  const formats = String(profile?.format ?? '').split('+');
  if (formats.includes('tap') && !formats.includes('junit')) {
    for (const file of profile?.files ?? []) {
      const path = testPath(root, file.path);
      if (path) files.add(path);
    }
  }
  let specFailures = false;
  for (const raw of String(output ?? '').split(/\r?\n/u)) {
    const line = stripVTControlCharacters(raw).trim();
    if (line === '✖ failing tests:') specFailures = true;
    if (!specFailures) continue;
    const location = /^test at (.+):\d+:\d+$/u.exec(line);
    const path = location && testPath(root, location[1]);
    if (path) files.add(path);
  }
  return [...files].sort();
}

/** The common Git directory holds local machine evidence shared by this repo's worktrees. */
export function cacheFile(root) {
  // One command locates the common directory once, however many main-red reads it makes.
  const common = commandFact(JSON.stringify(['main-red-common-dir', root]), () => checkoutCommonDir(root, { env: cleanGitEnvironment() }));
  if (common === null) throw new Refused('NO_POLICY', 'the repository common Git directory cannot be read for the local main comparison cache');
  return join(common, CACHE_RELATIVE);
}

/** Read only well-formed, machine-local cached outcomes; malformed data is treated as a miss. */
export function readCache(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4 * 1024 * 1024) return { version: CACHE_VERSION, entries: {} };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== CACHE_VERSION || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return { version: CACHE_VERSION, entries: {} };
    const entries = {};
    for (const [commit, files] of Object.entries(value.entries)) {
      if (!/^[0-9a-f]{40,64}$/u.test(commit) || !files || typeof files !== 'object' || Array.isArray(files)) continue;
      entries[commit] = {};
      for (const [path, outcome] of Object.entries(files)) {
        if (typeof path === 'string' && path && ['red', 'green'].includes(outcome?.result)) {
          const failures = cachedFailureSignatures(outcome, path);
          entries[commit][path] = { result: outcome.result, ...(failures ? { failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION } : {}),
            ...(outcome.fileIsolation === true && outcome.result === 'red' ? { fileIsolation: true } : {}),
            ...(typeof outcome.receiptId === 'string' ? { receiptId: outcome.receiptId } : {}),
            ...(/^[0-9a-f]{40,64}$/u.test(outcome.main ?? '') ? { main: outcome.main } : {}),
            ...(typeof outcome.at === 'string' && Number.isFinite(Date.parse(outcome.at)) ? { at: outcome.at } : {}) };
        }
      }
    }
    return { version: CACHE_VERSION, entries };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: CACHE_VERSION, entries: {} };
    return { version: CACHE_VERSION, entries: {} };
  }
}

/** Atomically persist a focused result without writing anything to board state or the worktree. */
function writeCache(file, value) {
  const directory = join(file, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Run Git with repository selectors cleared, keeping the main snapshot isolated. */
function gitCall(cwd, args, env) {
  return gitSpawnSync(['--no-replace-objects', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Build one clean temporary checkout at an exact commit (main's, or a pullboard test snapshot) and always remove it.
 * Detached by default; `onMainBranch` puts the commit on main's branch name instead. Why: a detached clone has no
 * accepted main, so apps/cli/src/io/run/tests.js refused a main comparison before any test and it came back a red that proved
 * nothing (#2950). Snapshots and candidate checkouts stay detached so they never pose as accepted main.
 * Only a run on this machine needs it: a runner comparison reads main from the object store in place [C7,#3323].
 */
export async function withMainCheckout(root, commit, run, { onMainBranch = false } = {}) {
  // The real temp path: a runner reports realpath locations (macOS /private/var), which must resolve inside the checkout.
  const directory = join(realpathSync(scratchRoot()), `pullboard-main-red-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const checkout = join(directory, 'checkout');
  const env = cleanGitEnvironment();
  try {
    const cloned = gitCall(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], env);
    if (cloned.status !== 0) return { unavailable: 'temporary main checkout could not be prepared' };
    // A main comparison sits on main's own branch name, so tools that look up accepted main (test budgets) find it (#2950).
    const branch = onMainBranch ? (mainCheckout(root)?.branch ?? 'refs/heads/main').replace(/^refs\/heads\//u, '') : null;
    const selected = gitCall(checkout, branch ? ['checkout', '--quiet', '--force', '-B', branch, commit] : ['checkout', '--quiet', '--force', '--detach', commit], env);
    if (selected.status !== 0) return { unavailable: 'the exact main commit could not be checked out temporarily' };
    const clean = gitCall(checkout, ['status', '--porcelain', '--untracked-files=all'], env);
    const head = gitCall(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'], env);
    if (clean.status !== 0 || clean.stdout !== '' || head.status !== 0 || head.stdout.trim() !== commit) {
      return { unavailable: 'the temporary main checkout was not clean at the captured commit' };
    }
    return await run(checkout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Main's exact commit as a runner source, read from the repository's object store: its tree and the trunk the runner
 * records, main's branch at `trunkCommit` (the commit itself for a main comparison, main's commit for an item head), as the
 * temporary clone's HEAD named it. Null when the commit cannot be read.
 * Why: a clone had its own cache id, so every comparison shipped the whole history to a cold runner cache [C7,#3323].
 */
export function mainRunnerSource(root, commit, trunkCommit = commit) {
  const tree = gitCall(root, ['rev-parse', '--verify', `${commit}^{tree}`], cleanGitEnvironment());
  if (tree.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree.stdout.trim())) return null;
  return { head: commit, tree: tree.stdout.trim(), trunk: { ref: mainCheckout(root)?.branch ?? 'refs/heads/main', commit: trunkCommit } };
}

/**
 * Whether main's copy of a test file asks for a desktop, read from the object store.
 * Why: a comparison with no working tree has no file to read, and only this one file is ever written, to a private folder.
 */
export function committedNeedsGui(root, commit, path) {
  const blob = gitCall(root, ['show', `${commit}:${path}`], cleanGitEnvironment());
  if (blob.status !== 0) return false;
  const directory = realpathSync(scratchFolder('pullboard-main-gui-'));
  try {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), blob.stdout);
    return testsNeedGui(directory, [path]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Hold the repo cache only for synchronous metadata access, never a checkout or a proof run. */
async function withComparisonCache(root, onWait, action) {
  const lease = await takeResource({
    name: 'main-red-cache', capacity: 1, scope: 'repo', root,
    agent: environment.get('PULLBOARD_AGENT') ?? `pid-${process.pid}`, onWait,
  });
  try { return action(); }
  finally { lease.release(); }
}

/** Retain the writer's exact immutable receipt before its isolated main checkout is removed. */
function retainComparisonReceipt(root, checkout, id) {
  const receipt = readGateReceipt(receiptStore(checkout), id);
  const store = receiptStore(root);
  if (!receipt || receipt.kind !== 'main-red' || !store) return null;
  const body = receiptBody(receipt);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const file = join(store, storeName(id));
  try { writeFileSync(file, body, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readFileSync(file, 'utf8') !== body) return null;
  }
  return id;
}

/** Only a completed structured remote run can supply a peer's recorded comparison environment. */
function comparisonObservationMatches(receipt, environment, browser) {
  const admitted = Date.parse(receipt?.admittedAt);
  const finished = Date.parse(receipt?.finishedAt);
  const slots = receipt?.runner?.slots;
  return receipt?.slot?.kind === 'runner' && receipt.inherited !== true
    && Number.isFinite(admitted) && Number.isFinite(finished) && admitted <= finished
    && Number.isSafeInteger(slots?.current) && slots.current > 0
    && Number.isSafeInteger(slots.limit) && slots.limit >= slots.current && typeof slots.elastic === 'boolean'
    && sameEnvironment(receipt.environment, environment)
    && receipt.runner.capabilities?.os === environment.platform
    && typeof browser === 'boolean' && receipt.runner.capabilities.browser === browser;
}

/**
 * Select the red run host, plus only registered peers with a fresh physical runtime and browser observation matching
 * the red executor. A peer whose recorded environment differs is never chosen; the red host itself is the fallback.
 */
export function comparisonExecutor(root, execution) {
  const original = requiredExecutorOf(execution?.executor);
  if (original?.kind !== 'ssh') return { requiredExecutor: original, browser: null };
  const registered = loadMachineSettings().runners ?? [];
  const observed = new Map();
  const now = Date.now();
  for (const receipt of recentReceipts(root, now)) {
    const at = Date.parse(receipt.finishedAt ?? receipt.at);
    const host = receipt.runner?.id;
    if (receipt.runner?.kind !== 'ssh' || typeof host !== 'string'
      || !Number.isFinite(at) || at > now || now - at > 86_400_000) continue;
    // Select newest first, including incomplete observations: an older match cannot mask a changed/unknown host.
    if (!observed.has(host) || at >= observed.get(host).at) observed.set(host, { at, receipt });
  }
  const red = observed.get(original.host)?.receipt;
  const browser = red?.runner?.capabilities?.browser;
  const redMatches = comparisonObservationMatches(red, execution.environment, browser);
  // The registered red run host always qualifies and stays first: it just ran the red, so when no peer receipt matches
  // the comparison runs there rather than refusing BAD_RUNNER_POOL [C7,#3670].
  if (!registered.some(runner => runner.host === original.host)) {
    throw new Refused('BAD_RUNNER_POOL', `the red run host ${original.host} is not a registered runner; register it and retry`);
  }
  const peers = registered.filter(runner => {
    if (runner.host === original.host) return false;
    const peer = observed.get(runner.host)?.receipt;
    return redMatches && comparisonObservationMatches(peer, execution.environment, browser) && (runner.browser > 0) === browser;
  }).map(runner => runner.host);
  const host = original.host;
  return { requiredExecutor: { kind: 'ssh', host, hosts: [host, ...peers] }, browser: redMatches ? browser : null };
}

/** Companions cannot inherit a red whose complete committed input closure they changed [V4,B3]. */
export function companionMainFailuresUntouched(root, { base, source, composed }, failures) {
  if (!base || !source || !composed || !Array.isArray(failures) || !failures.length) return false;
  try {
    const diff = gitSpawnSync(['diff', '--name-only', '-z', '--no-renames', source, composed, '--'],
      { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (diff.status !== 0) return false;
    const changed = new Set(diff.stdout.split('\0').filter(Boolean));
    // These inputs select execution itself; no source-import closure can prove them irrelevant.
    if ([...changed].some(path => ['pullboard.json', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'apps/cli/src/io/run/tests.js'].includes(path))) return false;
    const selection = selectAffectedTests(root, { base: source, commit: composed, changed: [...changed] });
    if (selection.full || failures.some(failure => selection.files.includes(failure.file))) return false;
    for (const commit of new Set([base, source, composed])) {
      const { closures } = testClosures(root, commit);
      for (const failure of failures) {
        const closure = closures.get(failure.file);
        if (!closure || !Array.isArray(closure.files) || !closure.files.includes(failure.file)
          || closure.files.some(file => changed.has(file))) return false;
      }
    }
    return true;
  } catch { return false; } // Unavailable graph or Git evidence never grants known-main acceptance.
}

/** The most cache generations kept, oldest first out, so the file stays under readCache's size bound. */
/** Generations the refresh reads and files it measures at once; the rest wait for the next landing. */
const REFRESH_GENERATIONS = 8, REFRESH_FILES = 16;
const CACHE_KEYS_KEPT = 512;

/**
 * Each test file's content key at main: its action key, which hashes the file, its import closure (the packages it
 * covers) and its declared inputs. Why: main moves on every landing, and a key by commit threw away every known red
 * whose test and code did not change, so each landing reran main [C7,#3166]. A file with no complete closure has none.
 */
async function contentKeys(root, commit, files) {
  try {
    const keys = await testActionKeys(root, { commit, files });
    return new Map(files.map(path => [path, /^[0-9a-f]{64}$/u.test(keys.get(path)?.inputKey ?? '') ? keys.get(path).inputKey : null]));
  } catch { return new Map(); }
}

/**
 * Whether a test's inputs are the same at two commits: the same action inputKey, so the file, its import closure and
 * declared inputs did not change. Why: a main red recorded by content excuses a batch's case only when the batch left
 * that test's inputs alone; a batch that changed them is compared with a fresh exact-main run [C7,#3166].
 */
export async function sameTestInputs(root, base, head, file) {
  const [before, after] = await Promise.all([contentKeys(root, base, [file]), contentKeys(root, head, [file])]);
  return Boolean(before.get(file)) && before.get(file) === after.get(file);
}

/** The content key a pinned comparison uses: the test's inputs plus the exact executor and runtime it must run on. */
function pinnedContentKey(inputKey, execution) {
  return inputKey ? createHash('sha256').update(JSON.stringify([inputKey, execution.executor ?? null, execution.environment ?? null])).digest('hex') : null;
}

/** Store one outcome under main's commit and its content key, and drop the oldest generations past the bound. */
function storeOutcome(cache, keys, path, outcome) {
  for (const key of keys) {
    if (!key) continue;
    const files = cache.entries[key] ?? {};
    delete cache.entries[key];
    cache.entries[key] = { ...files, [path]: outcome };
  }
  const all = Object.keys(cache.entries);
  for (const key of all.slice(0, Math.max(0, all.length - CACHE_KEYS_KEPT))) delete cache.entries[key];
}

/**
 * Compare named failed files against one captured main snapshot. Each result is cached by exact
 * commit and file; later submits reuse completed results rather than rerunning the same file.
 * A frozen-check comparison pinned to an actual executor and runtime always executes without that generic cache.
 *
 * The arguments are, in order: root (string), profile (object), onWait (optional callback taking a state object),
 * output (optional string, the failed phase's unchanged reporter output), and options (optional object: env, commit, detailed,
 * fresh, allowCancelled, onMeasuredReceipt, onStart, runnerAdmission, execution).
 * @param {...*} args - Capture the submit base and require exact test identities; fresh bypasses completed exact-main comparisons; onMeasuredReceipt records only freshly executed native receipts; onStart is told the file and its runner once the slot is taken, before the run.
 * A caller that names no runnerAdmission gets this machine's: with gate.runnersOnly on, every caller's comparison queues for a runner, never a local process (#3011).
 * env, when given, is process.env for the whole comparison; absent, process.env is used and nothing changes.
 * @returns {Promise<{ main: string|null, files: Array<{file:string,result:'red'|'green'}>, unavailable?: string }>}
 */
export function compareMainFailures(...args) {
  return withEnvironment(args[4]?.env, () => compareMainFailuresIn(...args));
}

/** compareMainFailures under its environment. */
function compareMainFailuresIn(...args) {
  // A red gate's comparison with main can run for many minutes (apps/cli/journeys/land/main.test.js: 1300-1900 s on a runner); inside a
  // driven gate it reports progress the whole time, so the drive's stall watch never restarts a gate that is still
  // comparing (#3451's gate stalled 20 min after its red). Outside a driven gate this reports nothing.
  return whileGateRuns(() => compareMainFailuresNow(...args));
}

/** The comparison itself: compareMainFailures without its progress beat. */
async function compareMainFailuresNow(root, profile, onWait, output = '', { commit, detailed = false, fresh = false, allowCancelled = false, onMeasuredReceipt, onStart, runnerAdmission = gateRunnerAdmission(), execution, recordedRuns = [], contentCache = true } = {}) {
  const main = commit ? { commit } : mainCheckout(root);
  if (!main?.commit) return { main: null, files: [], unavailable: 'the primary checkout has no committed main snapshot' };
  const policy = policyAt(root, main.commit);
  if (typeof policy.config.affectedTests !== 'string' || !policy.config.affectedTests.trim()) {
    return { main: main.commit, files: [], unavailable: 'no focused test runner configured' };
  }
  const pinned = execution !== undefined;
  let executor;
  let comparisonBrowser = null;
  if (pinned) {
    try { executor = requiredExecutorOf(execution?.executor); } catch { /* Invalid execution facts fail closed below. */ }
    if (!executor || !sameEnvironment(execution?.environment, execution?.environment)) {
      return { main: main.commit, files: [], unavailable: 'the candidate check has no complete executor and runtime identity' };
    }
  }
  const files = failingFiles(root, profile, output);
  if (!files.length) return { main: main.commit, files: [], unavailable: 'could not read which tests failed' };
  const file = cacheFile(root);
  const pinnedEntries = Object.create(null);
  // Board events carry native receipt bytes; bind them to the retained receipt, exact
  // main, focused command and runtime before using them as comparison evidence.
  if (pinned && detailed) for (const path of files) {
    const word = "'" + ('./' + path).replaceAll("'", "'\\''") + "'";
    // Receipts taken before the record-only prefix name the old `=0` command; both bind the same focused run.
    const commands = ['record', '0'].map(mode => createHash('sha256').update(`PULLBOARD_TEST_REUSE=${mode} ${policy.config.affectedTests.trimEnd()} ${word}`).digest('hex'));
    for (const run of [...recordedRuns].reverse()) {
      const receipt = readGateReceipt(receiptStore(root), run.id);
      if (!receipt || receiptBody(receipt) !== receiptBody(run) || receipt.kind !== 'main-red'
        || receipt.head !== main.commit || receipt.main !== main.commit || !commands.includes(receipt.command)
        || !sameEnvironment(receipt.environment, execution.environment)) continue;
      const failures = receipt.green ? [] : receipt.failureSignatures?.version === MAIN_FAILURE_SIGNATURE_VERSION
        ? receipt.failureSignatures.failures.map(row => row.file === path ? row : { ...row, ran: path }) : null;
      const outcome = { result: receipt.green ? 'green' : 'red', failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, receiptId: receipt.id };
      if (cachedFailureSignatures(outcome, path)) { pinnedEntries[path] = outcome; break; }
    }
  }
  const coarse = Object.create(null);
  // With gate.mainCaseFilter on, a detailed comparison runs main's copy of a file with only the cases the candidate failed
  // in it. Such a result answers this call alone: it is never read from or written to the whole-file cache [C7,#8761].
  const caseFilter = detailed && loadMachineSettings().gate?.mainCaseFilter === true;
  const casesOf = Object.create(null);
  if (caseFilter) for (const path of files) {
    const names = [...new Set((profile?.tests ?? []).filter(row => row.passed === false && row.file === path && typeof row.name === 'string' && row.name).map(row => row.name))];
    if (names.length) casesOf[path] = names;
  }
  const filteredOutcome = Object.create(null);
  /** A detailed comparison cannot reuse an old file-only or obsolete-signature cache entry. */
  const usable = outcome => ['red', 'green'].includes(outcome?.result)
    && (!detailed || Array.isArray(outcome.failures) || outcome.result === 'red' && outcome.fileIsolation === true);
  /** Read a consistent cache generation in a short metadata-only critical section. */
  // Executor-pinned evidence never reads or populates the generic commit entries: under main's commit it sees only its
  // recorded runs, and it shares content-keyed records only under a key that also names its executor and runtime.
  const snapshot = () => withComparisonCache(root, onWait, () => readCache(file))
    .then(cache => pinned ? { ...cache, entries: { ...cache.entries, [main.commit]: { ...pinnedEntries } } } : cache);
  const inputs = contentCache ? await contentKeys(root, main.commit, files) : new Map();
  const content = pinned ? new Map(files.map(path => [path, pinnedContentKey(inputs.get(path), execution)])) : inputs;
  /** A file's outcome at main: the exact commit's, else the one recorded for the same content key [C7,#3166]. */
  const outcomeOf = (entries, path) => casesOf[path] ? filteredOutcome[path] : usable(entries[main.commit]?.[path]) ? entries[main.commit][path]
    : content.get(path) && usable(entries[content.get(path)]?.[path]) ? entries[content.get(path)][path] : undefined;
  // A content-keyed outcome is already fresh: the same test and covered code at main were measured, so fresh reruns
  // only a file with no content key, and each main red runs at most once per content hash.
  const rerun = path => Boolean(casesOf[path]) || fresh && !pinned && !content.get(path);
  let cache = await snapshot();
  const missing = files.filter(path => !outcomeOf(cache.entries, path) || rerun(path));
  if (pinned && missing.length) {
    try { ({ requiredExecutor: executor, browser: comparisonBrowser } = comparisonExecutor(root, execution)); }
    catch (error) { return { main: main.commit, files: [], unavailable: error.message }; }
  }
  let failed = null;
  // A landing's missing files run at once, each under its own gate slot: three serial runs cost a landing 27 minutes
  // on 6 Nov before its bisect could start, while runner slots sat free. A submit keeps its files in FIFO order and
  // releases the slot between them, so other seats' gates interleave [V4,C7].
  /**
   * One flight per content hash: a reader takes this lock before it asks for a gate slot, so a second cold reader of the
   * same test content waits here, not in a slot of its own, and finds the first one's record when it gets the lock [C7,#3166].
   */
  const measureFile = async path => {
    const key = content.get(path);
    if (rerun(path) || !key) return measureFileUnlocked(path);
    const flight = await takeResource({
      name: `main-red-flight-${createHash('sha256').update(String(key)).digest('hex').slice(0, 32)}`, capacity: 1, scope: 'repo', root,
      agent: environment.get('PULLBOARD_AGENT') ?? `pid-${process.pid}`, onWait,
    });
    try { return await measureFileUnlocked(path); }
    finally { flight.release(); }
  };
  const measureFileUnlocked = async path => {
    try {
      // Another submit may have completed this file after the initial snapshot, or while this reader waited for the flight lock.
      if (!rerun(path) && outcomeOf((await snapshot()).entries, path)) return;
      /**
       * Run main's copy of the file under the held slot in `checkout`, retaining detailed identity when requested. A
       * `source` runs main's exact commit on the runner from the object store, with `checkout` the repository itself.
       */
      const measureIn = async (checkout, lease, source) => {
        // Another caller may have measured this content while this one waited for the slot: recheck after admission, so concurrent cold readers execute the file at most once [C7,#3166].
        if (!rerun(path) && outcomeOf((await snapshot()).entries, path)) return { reused: true };
        // A cache miss must execute main's file; completed exact-main comparisons remain reusable.
        const run = await runMainComparison(checkout, path, { detailed, ...(casesOf[path] ? { cases: casesOf[path] } : {}), gateLease: lease, waitMs: lease.waitMs, ...(source ? { source } : {}), signatureCapture: { version: MAIN_FAILURE_SIGNATURE_VERSION, derive: (run, root) => failureSignatures(run, root, { raw: true, allowCancelled }) } });
        if (pinned && ((executor.kind === 'ssh' ? !(executor.hosts ?? [executor.host]).includes(run.executionRunner) : Boolean(run.executionRunner))
          || !sameEnvironment(run.environment, execution.environment)
          || comparisonBrowser !== null && Boolean(lease.runner?.browser > 0) !== comparisonBrowser)) {
          throw new Refused('LAND_ENVIRONMENT', 'the merge-base comparison did not execute on a registered matching candidate check executor and exact runtime');
        }
        let receiptId;
        if (run.receiptId) {
          try {
            const id = retainComparisonReceipt(root, checkout, run.receiptId);
            if (id) receiptId = id;
            if (id && onMeasuredReceipt) await onMeasuredReceipt(id);
          } catch { /* Timing retention never changes the exact-main failure verdict. */ }
        }
        // A filtered run that ran none of the named cases tested nothing, so its green is never evidence [C7,#8761].
        if (casesOf[path] && run.isGreen && !(run.profile?.tests ?? []).some(row => row.passed === true && !row.skip && casesOf[path].includes(row.name))) throw new Error('the filtered main comparison ran none of the named cases, so its green is not evidence');
        // A red that names no failing test or crashed file is a run that never tested main, not main's red (#2950).
        // Named failing cases in the raw output count as well as the profile's rows: either proves main's file ran [C7,#3073].
        if (!run.isGreen && !failingFiles(checkout, run.profile, run.output).length && !failureSignatures(run, checkout, { raw: true, allowCancelled })?.length) throw new Error('the main comparison run named no failing test or crashed file, so its red is not evidence');
        coarse[path] = { file: path, result: run.isGreen ? 'green' : 'red', ...(receiptId ? { receiptId } : {}) };
        const named = detailed ? run.isGreen ? [] : failureSignatures(run, checkout, { allowCancelled }) : null;
        // A case defined in an imported helper names the helper; the file main ran stays beside it so either one finds the case (#2064).
        const failures = named?.map(row => row.file === path ? row : { ...row, ran: path }) ?? named;
        const fileIsolation = detailed && !run.isGreen && !failures && completeGate(run, { allowCancelled });
        if (detailed && !run.isGreen && !failures && !fileIsolation) throw new Error('focused main output has no complete named failure account');
        // Main's commit and the time ride with each result, so the first red after a green names its landing [#5809].
        return { result: run.isGreen ? 'green' : 'red', ...(failures ? { failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION } : {}),
          ...(fileIsolation ? { fileIsolation: true } : {}), ...(receiptId ? { receiptId } : {}), main: main.commit, at: new Date().toISOString() };
      };
      /** The slot options shared by both placements; only browser, gui and remote eligibility differ. */
      const slotOptions = (browser, gui, remote) => ({ executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, diagnostic: runnerAdmission.landing !== true, browser, gui, remote, agent: environment.get('PULLBOARD_AGENT'), kind: 'main-red', item: 'main', onWait, ...runnerAdmission, ...(pinned ? { requiredExecutor: executor } : {}) });
      /** Measure the file on this machine in a temporary checkout, or (`remote`) on a runner straight from the object store. */
      const inCheckout = async remote => {
        // A run on this machine needs main's files: a clean temporary checkout, with the slot taken there as before.
        if (!remote) return withMainCheckout(root, main.commit, async checkout => {
          // Use the same exact-file capability checks as ordinary named tests, on main's source.
          const browser = !browserFreeChecksEnabled() || await testsNeedBrowser(checkout, [path]);
          return withGateSlot(checkout, async lease => {
            // The runner is known only now: tell the caller before the run starts [C7,#3268].
            onStart?.({ file: path, runner: lease.runner?.host ?? null });
            return measureIn(checkout, lease);
          }, slotOptions(browser, testsNeedGui(checkout, [path]), false));
        }, { onMainBranch: true });
        // A runner reads main from this repository's object store under the repository's own cache id, so it reuses the
        // cache its submits fill and gets only missing objects: no clone here, no whole history there [C7,#3323].
        const source = mainRunnerSource(root, main.commit);
        if (!source) return { unavailable: 'the exact main commit could not be read from the object store' };
        const browser = !browserFreeChecksEnabled() || await testsNeedBrowser(root, [path], { commit: main.commit });
        return withGateSlot(root, async lease => {
          onStart?.({ file: path, runner: lease.runner?.host ?? null });
          // A slot that lands on this machine runs main's files in a temporary checkout; only a runner needs none [C7].
          if (!lease.runner) return withMainCheckout(root, main.commit, checkout => measureIn(checkout, lease), { onMainBranch: true });
          return measureIn(root, lease, { head: source.head, tree: source.tree });
        }, { ...slotOptions(browser, committedNeedsGui(root, main.commit, path), true), pinnedSource: { commit: source.head, tree: source.tree, trunk: source.trunk } });
      };
      let measured;
      // A comparison a landing waits for is a landing-class run; a diagnostic slot refuses the landing flag [C7].
      // History a runner may not receive keeps the comparison on this machine, as it ran before runners.
      try { measured = await inCheckout(pinned ? executor.kind === 'ssh' : true); }
      catch (error) {
        if (pinned || error?.code !== 'RUNNER_SECRET') throw error;
        if (runnerAdmission.runnerOnly) throw new Refused('RUNNER_SECRET', `${error.message}; gate.runnersOnly forbids local retry; correct the source privacy refusal and retry submit`);
        measured = await inCheckout(false);
      }
      if (measured.unavailable) throw new Error(measured.unavailable);
      if (measured.reused) return;
      if (casesOf[path]) { filteredOutcome[path] = measured; return; }
      if (pinned) pinnedEntries[path] = measured;
      await withComparisonCache(root, onWait, () => {
        const current = readCache(file);
        // Preserve a completed exact-main result published while this measurement ran.
        if (!pinned && !rerun(path) && outcomeOf(current.entries, path)) return;
        // A pinned run is also a real main run: it fills the generic content record a landing reads, never the commit entry.
        storeOutcome(current, pinned ? [content.get(path), inputs.get(path)] : [main.commit, content.get(path)], path, measured);
        writeCache(file, current);
      });
    }
    catch (error) {
      // A concurrent completed comparison can satisfy the request even if our own runner failed.
      if (rerun(path) || !outcomeOf((await snapshot()).entries, path)) failed ??= error;
    }
  };
  if (runnerAdmission.landing === true) await Promise.all(missing.map(measureFile));
  else for (const path of missing) await measureFile(path);
  // A file served by its content record is also recorded under this exact main, so the commit generation names every
  // red file known at it: the post-landing refresh reads generations, and a later landing hits the commit entry first.
  if (!pinned) await withComparisonCache(root, onWait, () => {
    const current = readCache(file);
    let copied = false;
    for (const path of files) {
      if (casesOf[path] || usable(current.entries[main.commit]?.[path]) || !content.get(path)) continue;
      const served = current.entries[content.get(path)]?.[path];
      if (usable(served)) { storeOutcome(current, [main.commit], path, served); copied = true; }
    }
    if (copied) writeCache(file, current);
  });
  cache = await snapshot();
  // A pinned comparison served by its content record names that record's retained receipt, as a fresh run would.
  if (pinned && onMeasuredReceipt) for (const path of files.filter(entry => !missing.includes(entry) && !pinnedEntries[entry])) {
    const receiptId = outcomeOf(cache.entries, path)?.receiptId;
    if (receiptId) try { await onMeasuredReceipt(receiptId); } catch { /* Timing retention never changes the verdict. */ }
  }
  const incomplete = files.some(path => !outcomeOf(cache.entries, path));
  // A timeout still has a real file verdict; it never supplies the missing case signatures.
  const coarseFiles = files.flatMap(path => {
    const row = coarse[path] ?? outcomeOf(cache.entries, path);
    return row ? [{ file: path, result: row.result, ...(row.receiptId ? { receiptId: row.receiptId } : {}) }] : [];
  });
  if (failed && (fresh || incomplete)) return { main: main.commit, files: [], ...(detailed ? { coarseFiles } : {}), unavailable: failed.message ?? 'main comparison could not be completed', ...(runnerAdmission.runnerOnly ? { runnerOnly: true } : {}) };
  if (incomplete) return { main: main.commit, files: [], ...(detailed ? { coarseFiles } : {}), unavailable: 'main comparison cache changed before the completed results could be read' };
  return { main: main.commit, files: files.map(path => ({ file: path, ...(detailed
    ? outcomeOf(cache.entries, path) : { result: outcomeOf(cache.entries, path).result }) })) };
}

/**
 * What the local cache already knows of main's failures in these files at one commit, without running anything. A file
 * the cache lacks is left out, so a case in it is never matched as main's [C7]. A file with no outcome at that commit
 * answers from the outcome recorded under its test input key (`inputKeys`), which hashes the file, its whole import
 * closure and its declared inputs. Why: main lands every few minutes, so a receipt keyed to one main is stale before a
 * gate reads it; a main that moved only outside the file's closure keeps its key, and so its receipt [C7,SC11].
 *
 * @param {string} root
 * @param {string} commit - The main commit whose recorded outcomes to read.
 * @param {string[]} files - Repository-relative test files.
 * @param {{ inputKeys?: Record<string, string> }} [options] - each file's test input key at that commit, when known.
 */
export function cachedMainComparison(root, commit, files, { inputKeys = {} } = {}) {
  try {
    const all = readCache(cacheFile(root)).entries, entries = all[commit] ?? {};
    const at = path => entries[path] ?? (/^[0-9a-f]{64}$/u.test(inputKeys[path] ?? '') ? all[inputKeys[path]]?.[path] : undefined);
    return { main: commit, files: [...new Set(files)].filter(path => at(path)).map(path => ({ file: path, ...at(path) })) };
  } catch { return { main: commit, files: [], unavailable: 'the main comparison cache cannot be read' }; }
}

/**
 * Record one finished main-test job's verdict in the local comparison cache, so submit, landing and serve find the
 * receipt at that main commit [C7,P7], and under the file's test input key when the run named one, so a main whose
 * inputs to the file are the same finds it too [C7,SC11]. A green is a complete row with no failing cases; a red names
 * the whole file (fileIsolation), since the job carries case names but no signatures. An existing row is kept.
 *
 * @param {string} root - The board host's repository.
 * @param {{ main: string, file: string, verdict: 'green' | 'red', job: string, at?: number, inputKey?: string }} receipt
 * @returns {boolean} whether a row was written
 */
export function recordMainTestReceipt(root, { main, file, verdict, job, at = Date.now(), inputKey = null }) {
  if (!/^[0-9a-f]{40,64}$/u.test(main ?? '') || !file || !['green', 'red'].includes(verdict)) return false;
  // Synchronous on purpose: the receipt applier is; a racing writer only costs a re-measure of one file.
  const path = cacheFile(root);
  const cache = readCache(path);
  const keys = [main, /^[0-9a-f]{64}$/u.test(inputKey ?? '') ? inputKey : null].filter(key => key && !cache.entries[key]?.[file]);
  if (!keys.length) return false;
  const outcome = verdict === 'green' ? { result: 'green', failures: [], signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION } : { result: 'red', fileIsolation: true };
  // A main keeps its place among the generations; past the bound, the oldest keys go, as storeOutcome drops them.
  for (const key of keys) cache.entries[key] = { ...cache.entries[key], [file]: { ...outcome, receiptId: job, main, at: new Date(at).toISOString() } };
  const all = Object.keys(cache.entries);
  for (const key of all.slice(0, Math.max(0, all.length - CACHE_KEYS_KEPT))) delete cache.entries[key];
  writeCache(path, cache);
  return true;
}

/** The newest commit-keyed generations of the cache, newest first; content-keyed records are not generations. */
function recentGenerations(cache, count, except = []) {
  return Object.keys(cache.entries).filter(key => /^[0-9a-f]{40}$/u.test(key) && !except.includes(key)).slice(-count).reverse();
}

/**
 * The newest recorded main outcome for one file across the latest commit generations, with the main it was measured
 * at; null when none of them holds a usable named result. Why: a proof keyed on a test's whole import closure dies
 * with every commit to main, since the gate code sits in every closure, so a landing re-proved the same main reds
 * after every landing. A red that main failed by the same case names at the last measured main, in a file the batch
 * did not touch, is carried forward; the detached refresh re-measures it at the new main behind the landing [C7].
 */
export function carriedMainOutcome(root, file, { generations = REFRESH_GENERATIONS } = {}) {
  let cache;
  try { cache = readCache(cacheFile(root)); } catch { return null; }
  for (const main of recentGenerations(cache, generations)) {
    const outcome = cache.entries[main]?.[file];
    if (outcome?.result === 'red' && outcome.signatureVersion === MAIN_FAILURE_SIGNATURE_VERSION && Array.isArray(outcome.failures) && outcome.failures.length) {
      return { main, files: [{ file, ...outcome }], carried: true };
    }
    if (outcome?.result === 'green') return { main, files: [{ file, ...outcome }], carried: true };
  }
  return null;
}

/**
 * The newest cached generation to refresh from when a batch base has no generation of its own; null when the base is
 * cached or no commit generation exists. Why: a hand-moved main has no cached comparisons, so the first red batch on it
 * re-measured every known red for minutes [C7,#3268].
 */
export function refreshSource(root, base) {
  let cache;
  try { cache = readCache(cacheFile(root)); } catch { return null; }
  if (cache.entries[base]) return null;
  return recentGenerations(cache, 1, [base])[0] ?? null;
}

/**
 * Refresh main's known red files at the published main in parallel, so the next red batch reads them instead of
 * rerunning each on main for eight minutes. The files come from the newest generations, not the prior main alone:
 * a comparison is cached under the exact commit it ran at, and a landing every three minutes meant the prior main
 * held nothing, so on 6 Nov every refresh ran "0 file(s)" [C7]. A file whose test inputs did not change is served from
 * its content record at once; one whose inputs changed, or whose red names no case, is measured again.
 */
export async function refreshMainRedComparisons(root, previousMain, publishedMain, onWait, compare = compareMainFailures, { generations = REFRESH_GENERATIONS, limit = REFRESH_FILES } = {}) {
  if (!previousMain || !publishedMain || previousMain === publishedMain) return [];
  const file = cacheFile(root);
  const cache = await withComparisonCache(root, onWait, () => readCache(file));
  const refreshed = cache.entries[publishedMain] ?? {};
  const done = path => ['red', 'green'].includes(refreshed[path]?.result)
    && refreshed[path].signatureVersion === MAIN_FAILURE_SIGNATURE_VERSION && Array.isArray(refreshed[path].failures);
  const knownRedFiles = [];
  for (const generation of [previousMain, ...recentGenerations(cache, generations, [previousMain, publishedMain])]) {
    for (const [path, outcome] of Object.entries(cache.entries[generation] ?? {})) {
      if (outcome?.result === 'red' && !done(path) && !knownRedFiles.includes(path)) knownRedFiles.push(path);
    }
  }
  return Promise.all(knownRedFiles.slice(0, limit).map(async path => {
    try {
      return await compare(root, { tests: [{ file: path, passed: false }] }, onWait, '', {
        commit: publishedMain, detailed: true, fresh: true, allowCancelled: true,
      });
    } catch (error) {
      return { main: publishedMain, files: [], unavailable: error?.message ?? String(error) };
    }
  }));
}

/** Map one or more main-red file results only when the row and its open owner are unambiguous. */
export function mainRedAttribution(root, board, comparison) {
  const redFiles = comparison.files.filter(entry => entry.result === 'red').map(entry => entry.file);
  if (!redFiles.length || !comparison.main) return { redFiles, row: null, item: null };
  const matches = matchingReworks(root, board, comparison.main, redFiles);
  return matches.length === 1
    ? { redFiles, ...matches[0] }
    : { redFiles, row: null, item: null };
}

/** Add only evidence the exact-main focused reruns established to an existing GATE_RED refusal. */
export function mainRedMessage(root, board, profile, comparison) {
  if (comparison.unavailable === 'focused main output has no complete named failure account') {
    return 'main not checked: focused main output has no complete named failure account';
  }
  if (comparison.unavailable === 'no focused test runner configured') {
    return 'main not checked: no focused test runner configured (affectedTests)';
  }
  if (comparison.unavailable === 'could not read which tests failed') {
    return 'main not checked: could not read which tests failed';
  }
  if (!comparison.files.length) return comparison.runnerOnly && comparison.unavailable ? `main not checked: ${comparison.unavailable}` : '';
  const attribution = mainRedAttribution(root, board, comparison);
  const names = (profile?.tests ?? []).filter(test => test.passed === false)
    .map(test => test.name ? `${test.file ?? 'unknown file'} (${test.name})` : test.file)
    .filter(Boolean);
  const redFiles = attribution.redFiles;
  if (!redFiles.length) return '';
  if (attribution.item && attribution.row) {
    const file = attribution.file;
    const testNames = names.length ? `: ${names.join(', ')}` : '';
    return `inherited main red for approved row ${attribution.row.id} (${file}${testNames}); open rework #${attribution.item.item_id} owns it\nnext: land #${attribution.item.item_id} first, then submit again`;
  }
  return `also red on main: ${redFiles.join(', ')}${names.length ? ` (${names.join(', ')})` : ''}`;
}

/** Current-main red files that uniquely identify one approved row and one open rework item. */
export function mainRedReworkItems(root, board) {
  return currentMainRedItems(root, board, ['open']);
}

/** Prioritize submitted repairs using the same exact-main failed-row evidence as build dispatch. */
export function mainRedReviewItems(root, board) {
  return currentMainRedItems(root, board, ['submitted']);
}

/** Local evidence is captured by the controller; ordered reservation carries only the resulting item identities. */
function currentMainRedItems(root, board, statuses) {
  let main;
  let cache;
  let policy;
  try {
    main = mainCheckout(root);
    if (!main?.commit) return [];
    cache = readCache(cacheFile(root));
    policy = mainPolicy(root);
  } catch { return []; }
  if (policy.commit !== main.commit) return [];
  const current = cache.entries[main.commit];
  if (!current) return [];
  let spec;
  try {
    const result = gitCall(root, ['show', `${main.commit}:${policy.config.spec}`], cleanGitEnvironment());
    if (result.status !== 0) return [];
    spec = parseSpec(result.stdout, { strictGrammarVersion: false });
  } catch { return []; }
  const redFiles = Object.entries(current).filter(([, result]) => result.result === 'red').map(([path]) => path);
  const matches = matchingReworks(root, board, main.commit, redFiles, { policy, spec, items: listItems(board, { all: true }), statuses });
  return statuses.includes('submitted') ? [...new Set(matches.map(match => match.item.item_id))]
    : matches.length === 1 ? [matches[0].item.item_id] : [];
}

/** Resolve exact-main approved rows and open items without using the candidate's spec text. */
function matchingReworks(root, board, commit, files, loaded = null) {
  let policy = loaded?.policy;
  let spec = loaded?.spec;
  let items = loaded?.items;
  try {
    policy ??= policyAt(root, commit);
    if (!spec) {
      const result = gitCall(root, ['show', `${commit}:${policy.config.spec}`], cleanGitEnvironment());
      if (result.status !== 0) return [];
      spec = parseSpec(result.stdout, { strictGrammarVersion: false });
    }
    items ??= listItems(board, { all: true });
  } catch { return []; }
  const open = items.filter(item => (loaded?.statuses ?? ['open']).includes(item.item_status));
  const matches = [];
  for (const file of files) {
    const rows = spec.rows.filter(row => row.status === 'approved' && row.gate === file);
    if (rows.length !== 1) continue;
    const row = rows[0];
    const owners = open.filter(item => item.item_spec_ids.split(',').map(id => id.trim()).includes(row.id));
    if (owners.length === 1) matches.push({ file, row, item: owners[0] });
  }
  return matches;
}

/** Present only complete case comparisons with a retained native receipt; these words grant no authority. */
export function mainFailureNotices(root, failures, comparison, { items = [], exclude } = {}) {
  if (!failures?.length || !comparison?.main || comparison.unavailable) return [];
  let runner;
  try { runner = policyAt(root, comparison.main).config.affectedTests; }
  catch { return []; } // Missing accepted policy cannot bind a comparison receipt.
  if (typeof runner !== 'string' || !runner.trim()) return [];
  const store = receiptStore(root);
  return failures.flatMap(failure => {
    if (!cachedFailureSignatures({ result: 'red', failures: [failure], signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION }, failure.file)) return [];
    const entries = comparison.files.filter(row => row.file === failure.file);
    if (entries.length !== 1) return [];
    const entry = entries[0];
    const receipt = readGateReceipt(store, entry.receiptId);
    const word = "'" + ('./' + failure.file).replaceAll("'", "'\\''") + "'";
    const commands = ['record', '0'].map(mode => createHash('sha256').update(`PULLBOARD_TEST_REUSE=${mode} ${runner.trimEnd()} ${word}`).digest('hex'));
    if (!['red', 'green'].includes(entry.result) || !receipt || receipt.kind !== 'main-red' || receipt.head !== comparison.main || receipt.main !== comparison.main
      || !commands.includes(receipt.command)
      || receipt.green !== (entry.result === 'green') || !cachedFailureSignatures(entry, failure.file)) return [];
    const mainCases = entry.failures.filter(row => row.name === failure.name);
    // The raw signature changes between identical runs; the stable one (error type plus deepest repository frame) does not, so
    // a case main fails with the same stable signature is main's failure, not one that "fails differently" [C7,#5303].
    const matched = matchingMainFailures([failure], comparison, comparison.main)
      ?? (mainCases.length === 1 && failure.stable && mainCases[0].stable === failure.stable && mainCases[0].stableData === failure.stableData
        ? matchingMainFailures([{ ...failure, signature: mainCases[0].signature }], comparison, comparison.main) : null);
    // A duplicate case or incomplete native failure account cannot become a candidate-only claim.
    if (entry.result === 'red' && (mainCases.length > 1 || entry.failures.length !== receipt.failures.length || entry.failures.some(row =>
      !receipt.failures.some(actual => actual.file === row.file && actual.name === row.name)))) return [];
    const owner = matched && linkKnownMainReworks(matched, items, exclude, true, true)?.failures[0].item;
    const status = matched ? 'also-main' : mainCases.length ? 'different-on-main' : 'candidate-only';
    const message = matched
      ? `also fails on main at ${comparison.main}: ${failure.file} :: ${failure.name} (not yours; ${owner ? `owner #${owner}` : 'accepted'})`
      : `${mainCases.length ? 'fails differently with your change' : 'fails only with your change'}: ${failure.file} :: ${failure.name}`;
    return [{ status, main: comparison.main, file: failure.file, name: failure.name,
      receiptId: receipt.id, ...(owner ? { owner } : {}), message: `${message} [main receipt ${receipt.id}]` }];
  });
}

/**
 * Run one shell command in a clean committed checkout under a runner-only gate slot and return the run.
 * Why the gate slot: it is the same runner path submit's checks take, so the command queues for a free runner and
 * never falls back to a local process; a machine with no runners keeps running these checks locally (callers decide).
 *
 * @param {string} checkout - A clean committed checkout; the runner receives its HEAD.
 * @param {string} command - The shell command to run at the checkout's root.
 * @param {{ kind: string, item?: string, admission?: object, onWait?: Function }} options - Receipt kind, the work it serves, and the captured runner-only admission.
 * @returns {Promise<{ isGreen: boolean, output: string, executionRunner?: string }>}
 */
export async function runCheckOnRunner(checkout, command, { kind, item = '', admission = gateRunnerAdmission(), onWait } = {}) {
  return withGateSlot(checkout, lease => runProfiledShellAsync(checkout, command, { gateLease: lease, waitMs: lease.waitMs }), {
    executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() },
    diagnostic: true, kind, item, agent: environment.get('PULLBOARD_AGENT'), onWait, ...admission, runnerOnly: true, remote: true,
  });
}

/** The last few lines of a failed run, for a refusal that names what broke. */
export function runTail(run) {
  return String(run?.output ?? '').trim().split('\n').filter(line => !/ExperimentalWarning|trace-warnings/u.test(line)).slice(-3).join(' ');
}
