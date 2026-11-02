/** Fresh per-file main comparisons for inherited submit reds [V1]. */
import { testClosures } from '../../../gate/index.js';
import { selectAffectedTests } from '../../../gate/index.js';
import { runnerExecutionServices } from '../../../../src/runners.js';
import { landingExecutionServices } from './landing-shards.js';
import { gitSpawnSync } from '../../../git/index.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  withGateSlot,
} from '../../../gate/index.js';
import { runMainComparison } from '../../../../src/gate-execution.js';
import {
  readGateReceipt,
  receiptBody,
  receiptStore,
} from '../../../gate/index.js';
import {
  cleanGitEnvironment,
  mainCheckout,
} from '../../../../src/git.js';
import {
  mainPolicy,
  policyAt,
} from '../../../sandbox/index.js';
import { parseSpec } from '../../../spec/index.js';
import { listItems } from '../../../store/index.js';
import {
  takeResource,
  requiredExecutorOf,
} from '../../../resources/index.js';
import { sameEnvironment } from '../../../sandbox/index.js';
import { Refused } from '../../../kernel/index.js';
import {
  matchingMainFailures,
  failureSignatures,
  cachedFailureSignatures,
  MAIN_FAILURE_SIGNATURE_VERSION,
} from './main-failure-matches.js';
import { linkKnownMainReworks } from '../../../store/index.js';
import { testsNeedBrowser } from '../../../gate/index.js';
import { testsNeedGui } from '../../../gate/index.js';
import { browserFreeChecksEnabled } from '../../../config/index.js';
import { loadMachineSettings } from '../../../config/index.js';
import { recentReceipts } from '../../../gate/index.js';

const CACHE_RELATIVE = 'pullboard/main-red.json';

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
function failingFiles(root, profile, output) {
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
function cacheFile(root) {
  const result = gitSpawnSync(['--no-replace-objects', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
  });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the repository common Git directory cannot be read for the local main comparison cache');
  return join(result.stdout.trim(), CACHE_RELATIVE);
}

/** Read only well-formed, machine-local cached outcomes; malformed data is treated as a miss. */
function readCache(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4 * 1024 * 1024) return { version: 1, entries: {} };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return { version: 1, entries: {} };
    const entries = {};
    for (const [commit, files] of Object.entries(value.entries)) {
      if (!/^[0-9a-f]{40,64}$/u.test(commit) || !files || typeof files !== 'object' || Array.isArray(files)) continue;
      entries[commit] = {};
      for (const [path, outcome] of Object.entries(files)) {
        if (typeof path === 'string' && path && ['red', 'green'].includes(outcome?.result)) {
          const failures = cachedFailureSignatures(outcome, path);
          entries[commit][path] = { result: outcome.result, ...(failures ? { failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION } : {}),
            ...(typeof outcome.receiptId === 'string' ? { receiptId: outcome.receiptId } : {}) };
        }
      }
    }
    return { version: 1, entries };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: {} };
    return { version: 1, entries: {} };
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

/** Build one clean temporary checkout at an exact commit (main's, or a pullboard test snapshot) and always remove it. */
export async function withMainCheckout(root, commit, run) {
  const directory = join(tmpdir(), `pullboard-main-red-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const checkout = join(directory, 'checkout');
  const env = cleanGitEnvironment();
  try {
    const cloned = gitCall(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], env);
    if (cloned.status !== 0) return { unavailable: 'temporary main checkout could not be prepared' };
    const selected = gitCall(checkout, ['checkout', '--quiet', '--force', '--detach', commit], env);
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

/** Hold the repo cache only for synchronous metadata access, never a checkout or a proof run. */
async function withComparisonCache(root, onWait, action) {
  const lease = await takeResource({
    name: 'main-red-cache', capacity: 1, scope: 'repo', root,
    agent: process.env.PULLBOARD_AGENT ?? `pid-${process.pid}`, onWait,
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
  const file = join(store, `${id}.json`);
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

/** Select only registered peers with a fresh physical runtime and browser observation matching the red executor. */
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
  const hosts = registered.filter(runner => {
    if (runner.host === original.host) return !red || redMatches && (runner.browser > 0) === browser;
    const peer = observed.get(runner.host)?.receipt;
    return redMatches && comparisonObservationMatches(peer, execution.environment, browser) && (runner.browser > 0) === browser;
  }).map(runner => runner.host);
  if (!hosts.length) throw new Refused('BAD_RUNNER_POOL', 'no registered runner has the candidate comparison environment; record a matching runner and retry');
  const host = hosts.includes(original.host) ? original.host : hosts[0];
  return { requiredExecutor: { kind: 'ssh', host, hosts: [host, ...hosts.filter(value => value !== host)] }, browser: redMatches ? browser : null };
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
    if ([...changed].some(path => ['pullboard.json', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bin/run-tests.js'].includes(path))) return false;
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

/**
 * Compare named failed files against one captured main snapshot. Each result is cached by exact
 * commit and file; later submits reuse completed results rather than rerunning the same file.
 * A frozen-check comparison pinned to an actual executor and runtime always executes without that generic cache.
 *
 * @param {string} root
 * @param {object} profile
 * @param {(state:object)=>void} [onWait]
 * @param {string} [output] - The failed phase's unchanged reporter output.
 * @param {{commit?: string, detailed?: boolean, fresh?: boolean, onMeasuredReceipt?: (id:string)=>Promise<void>, runnerAdmission?: object, execution?: {executor:object, environment:object}}} [options] - Capture the submit base and require exact test identities; fresh bypasses completed exact-main comparisons; onMeasuredReceipt records only freshly executed native receipts.
 * @returns {Promise<{ main: string|null, files: Array<{file:string,result:'red'|'green'}>, unavailable?: string }>}
 */
export async function compareMainFailures(root, profile, onWait, output = '', { commit, detailed = false, fresh = false, onMeasuredReceipt, runnerAdmission = {}, execution, recordedRuns = [] } = {}) {
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
  const file = pinned ? null : cacheFile(root);
  const pinnedEntries = Object.create(null);
  // Board events carry native receipt bytes; bind them to the retained receipt, exact
  // main, focused command and runtime before using them as comparison evidence.
  if (pinned && detailed) for (const path of files) {
    const word = "'" + ('./' + path).replaceAll("'", "'\\''") + "'";
    const command = createHash('sha256').update(`PULLBOARD_TEST_REUSE=0 ${policy.config.affectedTests.trimEnd()} ${word}`).digest('hex');
    for (const run of [...recordedRuns].reverse()) {
      const receipt = readGateReceipt(receiptStore(root), run.id);
      if (!receipt || receiptBody(receipt) !== receiptBody(run) || receipt.kind !== 'main-red'
        || receipt.head !== main.commit || receipt.main !== main.commit || receipt.command !== command
        || !sameEnvironment(receipt.environment, execution.environment)) continue;
      const failures = receipt.green ? [] : receipt.failureSignatures?.version === MAIN_FAILURE_SIGNATURE_VERSION
        ? receipt.failureSignatures.failures.map(row => row.file === path ? row : { ...row, ran: path }) : null;
      const outcome = { result: receipt.green ? 'green' : 'red', failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, receiptId: receipt.id };
      if (cachedFailureSignatures(outcome, path)) { pinnedEntries[path] = outcome; break; }
    }
  }
  const coarse = Object.create(null);
  /** A detailed comparison cannot reuse an old file-only or obsolete-signature cache entry. */
  const usable = outcome => ['red', 'green'].includes(outcome?.result)
    && (!detailed || Array.isArray(outcome.failures));
  /** Read a consistent cache generation in a short metadata-only critical section. */
  // Executor-pinned evidence never reads or populates the generic commit/file cache.
  const snapshot = () => pinned
    ? Promise.resolve({ version: 1, entries: { [main.commit]: { ...pinnedEntries } } })
    : withComparisonCache(root, onWait, () => readCache(file));
  let cache = await snapshot();
  const missing = files.filter(path => !usable(cache.entries[main.commit]?.[path]) || fresh && !pinned);
  if (pinned && missing.length) {
    try { ({ requiredExecutor: executor, browser: comparisonBrowser } = comparisonExecutor(root, execution)); }
    catch (error) { return { main: main.commit, files: [], unavailable: error.message }; }
  }
  let failed = null;
  for (const path of missing) {
    try {
      // Another submit may have completed this file after the initial snapshot.
      if (!fresh && usable((await snapshot()).entries[main.commit]?.[path])) continue;
      // The slot is taken on the clean main checkout, so a runner can take it even when this worktree is dirty.
      const measured = await withMainCheckout(root, main.commit, async checkout => {
        // Use the same exact-file capability checks as ordinary named tests, on main's source.
        const browser = !browserFreeChecksEnabled() || await testsNeedBrowser(checkout, [path]);
        const gui = testsNeedGui(checkout, [path]);
        /** Run main's copy of the file under one gate slot, retaining detailed identity when requested. */
        const measure = remote => withGateSlot(checkout, async lease => {
          // A cache miss must execute main's file; completed exact-main comparisons remain reusable.
          const run = await runMainComparison(checkout, path, { detailed, gateLease: lease, waitMs: lease.waitMs, signatureCapture: { version: MAIN_FAILURE_SIGNATURE_VERSION, derive: (run, root) => failureSignatures(run, root, { raw: true }) } });
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
          coarse[path] = { file: path, result: run.isGreen ? 'green' : 'red', ...(receiptId ? { receiptId } : {}) };
          const named = detailed ? run.isGreen ? [] : failureSignatures(run, checkout) : null;
          // A case defined in an imported helper names the helper; the file main ran stays beside it so either one finds the case (#2064).
          const failures = named?.map(row => row.file === path ? row : { ...row, ran: path }) ?? named;
          if (detailed && !run.isGreen && !failures) throw new Error('focused main output has no complete named failure account');
          return { result: run.isGreen ? 'green' : 'red', ...(failures ? { failures, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION } : {}), ...(receiptId ? { receiptId } : {}) };
        }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, diagnostic: true, browser, gui, remote, agent: process.env.PULLBOARD_AGENT, kind: 'main-red', onWait, ...runnerAdmission, ...(pinned ? { requiredExecutor: executor } : {}) });
        // History a runner may not receive keeps the comparison on this machine, as it ran before runners.
        try { return await measure(pinned ? executor.kind === 'ssh' : true); }
        catch (error) {
          if (pinned || error?.code !== 'RUNNER_SECRET') throw error;
          if (runnerAdmission.runnerOnly) throw new Refused('RUNNER_SECRET', `${error.message}; gate.runnersOnly forbids local retry; correct the source privacy refusal and retry submit`);
          return measure(false);
        }
      });
      if (measured.unavailable) throw new Error(measured.unavailable);
      if (pinned) pinnedEntries[path] = measured;
      else await withComparisonCache(root, onWait, () => {
        const current = readCache(file);
        // Preserve a completed exact-main result published while this measurement ran.
        if (!fresh && usable(current.entries[main.commit]?.[path])) return;
        current.entries[main.commit] ??= {};
        current.entries[main.commit][path] = measured;
        writeCache(file, current);
      });
    }
    catch (error) {
      // A concurrent completed comparison can satisfy the request even if our own runner failed.
      if (fresh || !usable((await snapshot()).entries[main.commit]?.[path])) failed ??= error;
    }
  }
  cache = await snapshot();
  const incomplete = files.some(path => !usable(cache.entries[main.commit]?.[path]));
  // A timeout still has a real file verdict; it never supplies the missing case signatures.
  const coarseFiles = files.flatMap(path => {
    const row = coarse[path] ?? cache.entries[main.commit]?.[path];
    return row ? [{ file: path, result: row.result, ...(row.receiptId ? { receiptId: row.receiptId } : {}) }] : [];
  });
  if (failed && (fresh || incomplete)) return { main: main.commit, files: [], ...(detailed ? { coarseFiles } : {}), unavailable: failed.message ?? 'main comparison could not be completed', ...(runnerAdmission.runnerOnly ? { runnerOnly: true } : {}) };
  if (incomplete) return { main: main.commit, files: [], ...(detailed ? { coarseFiles } : {}), unavailable: 'main comparison cache changed before the completed results could be read' };
  return { main: main.commit, files: files.map(path => ({ file: path, ...(detailed
    ? cache.entries[main.commit][path] : { result: cache.entries[main.commit][path].result }) })) };
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
    const command = `PULLBOARD_TEST_REUSE=0 ${runner.trimEnd()} ${word}`;
    if (!['red', 'green'].includes(entry.result) || !receipt || receipt.kind !== 'main-red' || receipt.head !== comparison.main || receipt.main !== comparison.main
      || receipt.command !== createHash('sha256').update(command).digest('hex')
      || receipt.green !== (entry.result === 'green') || !cachedFailureSignatures(entry, failure.file)) return [];
    const matched = matchingMainFailures([failure], comparison, comparison.main);
    const mainCases = entry.failures.filter(row => row.name === failure.name);
    // A duplicate case or incomplete native failure account cannot become a candidate-only claim.
    if (entry.result === 'red' && (mainCases.length > 1 || entry.failures.length !== receipt.failures.length || entry.failures.some(row =>
      !receipt.failures.some(actual => actual.file === row.file && actual.name === row.name)))) return [];
    const owner = matched && linkKnownMainReworks(matched, items, exclude)?.failures[0].item;
    const status = matched ? 'also-main' : mainCases.length ? 'different-on-main' : 'candidate-only';
    const message = matched
      ? `also fails on main at ${comparison.main}: ${failure.file} :: ${failure.name} (not yours; ${owner ? `owner #${owner}` : 'accepted'})`
      : `${mainCases.length ? 'fails differently with your change' : 'fails only with your change'}: ${failure.file} :: ${failure.name}`;
    return [{ status, main: comparison.main, file: failure.file, name: failure.name,
      receiptId: receipt.id, ...(owner ? { owner } : {}), message: `${message} [main receipt ${receipt.id}]` }];
  });
}
