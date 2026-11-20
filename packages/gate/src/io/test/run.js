/** pullboard test: named test files on the runner pool, with the focused runner's per-file timeout [C7]. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  availableParallelism,
  loadavg,
  tmpdir,
} from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { testsNeedBrowser } from '../browser/admission.js';
import { selectAffectedTests } from '../affected/tests.js';
import { selectRegistryGuards } from '../../../../kernel/index.js';
import { mainPolicy } from '../../../../sandbox/index.js';
import { runnerPolicyRecord } from '../../../../sandbox/index.js';
import { RUNNER_POLICY_FILE } from '../../../../sandbox/index.js';
import { affectedCommand } from './affected-command.js';
import { acceptedBudgetTrunk } from './file/policy.js';
import {
  cleanGitEnvironment,
  git as readGit,
  headCommit,
} from '../../../../git/index.js';
import {
  projectNeedsGui,
  testsNeedGui,
} from '../gui/admission.js';
import { Refused } from '../../../../kernel/index.js';
import {
  retainTestOutput,
  renderTestSummary,
} from './summary.js';
import { readFileSync } from 'node:fs';
import { timingSource } from '../run/timing.js';
import { whileSeatAlive } from '../keepalive.js';
import { announceTestRun } from '../../logic/test/progress.js';
import { trackedDefaultTestFiles } from './selection.js';
import { recordGreenRun } from '../shards/green.js';
import {
  preQueueReuse,
  reuseReceipt,
} from './action/cache.js';
import {
  browserFreeChecksEnabled,
  gateRunnersFirstEnabled,
  gateRunnerAdmission,
  loadMachineSettings,
} from '../../../../config/index.js';

/** Give a direct full suite the same admitted execution and immutable receipt writer as a gate. */
export async function runFullSuite(root, runner, executionServices) {
  if (relative(root, runner).split(sep).join('/') !== 'apps/cli/src/io/run/tests.js' || !timingSource(root)) return null;
  let policy;
  try { policy = mainPolicy(root); } catch { return null; }
  const [{ withGateSlot }, { fullGateRunAsync }] = await Promise.all([import('../main.js'), import('../execution.js')]);
  const files = trackedDefaultTestFiles(root, process.env);
  const { cpuRunnerRequired } = await import('../admission/cpu/load.js');
  const result = await withGateSlot(root, lease => fullGateRunAsync(root, { ...policy.config, gate: 'node apps/cli/src/io/run/tests.js --all' }, false,
    { gateLease: lease, waitMs: lease.waitMs, kind: 'suite' }),
  { executionServices, browser: true, gui: testsNeedGui(root, files), runnerOnly: cpuRunnerRequired(root, files), ...testRunnerAdmission(), kind: 'gate' });
  return result;
}

/** Capture the machine's runner-only cutoff and name the setting before any test admission waits. */
function testRunnerAdmission() {
  const admission = gateRunnerAdmission();
  if (admission.runnerOnly) process.stderr.write('gate.runnersOnly is on; tests wait for a registered runner with no local fallback\n');
  return admission;
}

/** Keep each named file a test file inside this checkout, as the runner's checkout names it. */
export function testFiles(root, files) {
  if (!files.length) throw new Refused('USAGE', 'name the test files to run: pullboard test test/one.test.js [more files]');
  return files.map((file) => {
    const path = relative(root, resolve(root, file));
    if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep) || !existsSync(join(root, path))) {
      throw new Refused('NO_TEST_FILE', `${file} is not a file in this checkout; name test files by their path from the checkout root`);
    }
    return path.split(sep).join('/');
  });
}

/** Run Git in this checkout with inherited selectors cleared and a private index. */
function git(root, args, env) {
  const run = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.status !== 0) throw new Refused('TEST_SNAPSHOT', `could not snapshot this checkout for the runners (git ${args[0]}): ${run.stderr.trim().split('\n')[0]}`);
  return run.stdout.trim();
}

/**
 * One line naming the tracked files with uncommitted changes, or null for a clean checkout.
 *
 * Why: the runners test the committed source, so an uncommitted edit (a debug line, a stricter assertion, a fixed
 * test) is not under test, and four builders read a result as proof of an edit it never ran (#3733).
 *
 * @param {string} root - The checkout `pullboard test` runs from.
 * @returns {string | null}
 */
export function uncommittedNotice(root) {
  try {
    const head = headCommit(root);
    if (!head) return null;
    const files = git(root, ['diff', '--name-only', 'HEAD'], cleanGitEnvironment()).split('\n').filter(Boolean);
    if (!files.length) return null;
    const shown = files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ');
    return `pullboard test: uncommitted changes in ${shown}; the runner tests the committed source at ${head.slice(0, 10)}, so these edits are not under test; commit them and run again`;
  } catch { return null; /* an unreadable tree is reported by the snapshot step that follows */ }
}

/**
 * The commit a runner checks out: HEAD when the tree is clean, else a snapshot commit of the working tree, made
 * with a private index so the checkout's own index and branches stay as they are. Ignored files stay out.
 */
async function snapshotCommit(root) {
  const { runnerSource } = await import('../../logic/policy.js');
  if (runnerSource(root)) return { commit: headCommit(root), clean: true };
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-test-index-'));
  try {
    const env = { ...cleanGitEnvironment(), GIT_INDEX_FILE: join(folder, 'index') };
    const head = headCommit(root);
    if (head) git(root, ['read-tree', head], env);
    git(root, ['add', '-A', '--', '.'], env);
    const tree = git(root, ['write-tree'], env);
    const commit = git(root, ['-c', 'user.name=pullboard', '-c', 'user.email=test@pullboard.invalid', 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'pullboard test snapshot'], env);
    return { commit, clean: false };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** Run the files where the work is: this clean checkout, or a clean temporary checkout of its snapshot. */
export async function inCleanCheckout(root, work, withMainCheckout) {
  const { commit, clean } = await snapshotCommit(root);
  if (clean) return work(root);
  const accepted = acceptedBudgetTrunk(root);
  const result = await withMainCheckout(root, commit, async checkout => {
    if (accepted?.commit) {
      const trunk = { ref: accepted.branch ?? accepted.ref, commit: accepted.commit };
      const env = cleanGitEnvironment();
      git(checkout, ['update-ref', trunk.ref, trunk.commit], env);
      const tree = git(checkout, ['rev-parse', 'HEAD^{tree}'], env);
      const record = runnerPolicyRecord({ id: randomUUID(), commit, tree, trunk });
      writeFileSync(join(checkout, '.git', RUNNER_POLICY_FILE), JSON.stringify(record), { mode: 0o600 });
    }
    return work(checkout);
  });
  if (result?.unavailable) throw new Refused('TEST_SNAPSHOT', `${result.unavailable}; commit the work and run pullboard test again`);
  return result;
}

/** Why a run stayed on this machine, so the person sees which setting would send it to the runner pool. */
function localReason() {
  if (!(loadMachineSettings().runners ?? []).length) return 'no runners are registered on this machine; add one with pullboard runner add <ssh-host> --slots <n> --browser <n>';
  if (!gateRunnersFirstEnabled()) return 'gate.runnersFirst is off, so a free local slot came first; turn it on with pullboard settings gate.runnersFirst on';
  return 'no registered runner had a free slot it could use; pullboard resources shows each runner';
}

/**
 * Hold a local start until the one-minute load is under one per core, so test runs never pile onto a busy
 * machine while it has no runner to send them to [C7]. Returns what the run says about its start. A test fixture
 * board (PULLBOARD_FIXTURE_BOARD=1) starts at once: the outer gated run already owns the load budget, so waiting
 * again inside it double-counts and times nested journeys out on a loaded runner.
 *
 * @param {{ env?: Record<string, string | undefined>, read?: () => number[], cores?: number, wait?: (ms: number) => Promise<unknown>, pollMs?: number, maxWaitMs?: number, onWait?: (state: object) => void }} [options]
 * @returns {Promise<{ load: number, cores: number, waitedMs: number, note: string }>}
 */
export async function localLoadStart({ env = process.env, read = loadavg, cores = availableParallelism(), wait = sleep, pollMs = 2000, maxWaitMs = 10 * 60_000, onWait } = {}) {
  const started = Date.now();
  let load = read()[0];
  const fixture = env.PULLBOARD_FIXTURE_BOARD === '1';
  while (!fixture && load >= cores && Date.now() - started < maxWaitMs) {
    onWait?.({ state: 'local-load', load, cores });
    process.stderr.write(`pullboard test: load ${load.toFixed(1)} on ${cores} cores; waiting for it to drop under ${cores} before a local start\n`);
    await wait(pollMs);
    load = read()[0];
  }
  const waitedMs = Date.now() - started;
  const under = load < cores;
  return { load, cores, waitedMs, note: `load-aware local start at load ${load.toFixed(1)} on ${cores} cores${waitedMs >= pollMs ? ` after ${Math.round(waitedMs / 1000)}s waiting` : ''}${under ? '' : ' (wait cap reached)'}` };
}

/**
 * Split named files into those a runner already proved under the same inputs and those that must queue. Null when
 * nothing is reused or anything about the lookup is unavailable (including no trustedTooling handed in by the caller), so the caller runs every file as before.
 *
 * @returns {Promise<{ run: string[], text: string } | null>}
 */
async function dropReused(checkout, paths, trustedTooling) {
  try {
    if (process.env.PULLBOARD_TEST_REUSE === '0') return null;
    if (typeof trustedTooling !== 'function') return null;
    const split = await preQueueReuse(checkout, headCommit(checkout), paths, trustedTooling().tooling.sha256);
    if (!split.reused.size) return null;
    // All reused: the stored TAP is the proof. Mixed: the runner's own TAP counts what ran, the reused files are named.
    return { run: split.run, text: reuseReceipt(split.reused, { tap: !split.run.length }) };
  } catch { return null; }
}

/**
 * Run named test files through a gate slot, which deals them to the registered runners first (#1054); the focused
 * runner (pullboard.json affectedTests) gives each file its timeout. A red file is compared with main's recorded
 * result for that file, so a failure main already has reads as known. A single named file skips that comparison
 * unless compareMain is set. Even then, a failing file that `knownRed(file)` gives a reason for starts no main run.
 *
 * @returns {Promise<{ green: boolean, output: string, runner: string, seconds: number, files: string[], known: Array<{file: string, result: string}>, main: string|null }>}
 */
export async function runTestFiles(root, config, files, { agent, item, onWait, say, timers = {}, affected = false, compareMain = false, diagnose = false, executionServices, compareMainFailures, withMainCheckout, failureSignatures, knownRed } = {}) {
  if (affected && files.length) throw new Refused('USAGE', 'use pullboard test --affected without file arguments, or name the files without --affected');
  const policy = affected ? mainPolicy(root) : null;
  if (policy) config = policy.config;
  if (typeof config.affectedTests !== 'string' || !config.affectedTests.trim()) {
    throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node apps/cli/src/io/run/tests.js"');
  }
  let paths = affected ? [] : testFiles(root, files);
  if (typeof compareMainFailures !== 'function' || typeof withMainCheckout !== 'function') throw new TypeError('test files need an explicit accepted-main comparison');
  const { runProfiledShellAsync, withGateSlot } = await import('../main.js');
  const started = Date.now();
  const uncommitted = uncommittedNotice(root);
  if (uncommitted) process.stderr.write(uncommitted + '\n');
  const admission = testRunnerAdmission();
  const noRunners = !(loadMachineSettings().runners ?? []).length;
  const loadStart = noRunners && !admission.runnerOnly ? await localLoadStart({ onWait }) : null;
  // The claim stays live for the whole run: a long runner wait must not look like a gone seat (#3430).
  let requested = null;
  const run = await whileSeatAlive(root, () => inCleanCheckout(root, async (checkout) => {
    let full = false;
    if (policy) {
      const options = { base: policy.commit, trunk: policy.commit };
      const selection = selectAffectedTests(checkout, options);
      const guards = selectRegistryGuards(checkout, config.registryGuards, { ...options, git: readGit });
      full = selection.full;
      paths = [...new Set([...(full ? [] : selection.files), ...guards])].sort();
      if (paths.length) paths = testFiles(checkout, paths);
    }
    // Files whose inputs match a runner-completed green never queue: no slot is held for them [C7].
    let reusedText = '';
    if (!full && !diagnose && paths.length) {
      const split = await dropReused(checkout, paths, executionServices?.runners?.trustedTooling);
      if (split) {
        reusedText = split.text;
        requested = paths;
        if (!split.run.length) return { isGreen: true, output: split.text + '# all ' + paths.length + ' test files reused; none ran\n', executionRunner: null, reusedAll: true };
        requested = paths;
        paths = split.run;
      }
    }
    const focused = paths.length ? affectedCommand(config, paths) : '';
    if (full && !config.gate?.trim()) throw new Refused('NO_TEST_RUNNER', 'affected selection needs the full project gate; set gate in accepted pullboard.json');
    const command = full ? `(${config.gate})${focused ? ' && ' + focused : ''}` : (focused || 'true');
    const browser = full || !browserFreeChecksEnabled() || await testsNeedBrowser(checkout, paths);
    const ran = await withGateSlot(checkout, async (lease) => {
      const stop = typeof say === 'function' ? announceTestRun(say, { host: lease.runner?.host, files: paths, ...timers }) : () => {};
      try { return await runProfiledShellAsync(checkout, command, { gateLease: lease, waitMs: lease.waitMs, stages: true }); } finally { stop(); }
    },
      { executionServices, ...admission, browser, gui: (full && projectNeedsGui(checkout)) || testsNeedGui(checkout, paths), shortEligible: !full && !diagnose, agent, item, itemCheck: Boolean(item) && !diagnose, diagnostic: diagnose, kind: 'test', onWait });
    // A green runner run of named files is the gate's proof of them at this tree: the submit's item check takes it [C7].
    if (!full && !diagnose && ran?.isGreen) recordGreenRun(ran, { runner: config.affectedTests, files: paths, timingRunId: ran.id ?? null });
    return reusedText && typeof ran?.output === 'string' ? { ...ran, output: reusedText + ran.output } : ran;
  }, withMainCheckout), { everyMs: 30_000 });
  const summary = retainTestOutput(root, run.output, { root: run.executionRoot ?? root, profile: run.profile });
  const result = { green: run.isGreen, output: diagnose && !run.isGreen ? readFileSync(summary.logPath, 'utf8') : renderTestSummary(summary), ...summary, runner: run.executionRunner || 'this machine', seconds: Math.round((Date.now() - started) / 1000), files: requested ?? paths, known: [], main: null,
    ...(run.executionRunner ? {} : { local: loadStart ? `${localReason()}; ${loadStart.note}` : localReason() }),
    ...(run.screenshotsPath ? { screenshotsPath: run.screenshotsPath } : {}) };
  // A one-file run is a builder diagnosing its own red: main's run of that file waits for a second runner slot and
  // answers a question nobody asked, so it runs only on request (compareMain, pullboard test --compare-main).
  const skipMain = !affected && paths.length === 1 && !compareMain;
  if (!run.isGreen && skipMain) result.mainSkipped = 'one file: add --compare-main to also run it on main';
  // A known red needs no main run: "is it red" is enough, and the candidate's own result is the proof [C7].
  const redFiles = !run.isGreen && compareMain && typeof knownRed === 'function' ? [...new Set((typeof failureSignatures === 'function' ? failureSignatures(run, run.executionRoot ?? root) : null)?.map(row => row.file) ?? paths)] : [];
  const reasons = typeof knownRed === 'function' ? redFiles.map(knownRed) : [];
  const knownReds = redFiles.length > 0 && reasons.every(Boolean);
  if (knownReds) result.mainSkipped = reasons[0];
  if (!run.isGreen && !skipMain && !knownReds) {
    const compared = await compareMainFailures(root, run.profile, onWait, readFileSync(summary.logPath, 'utf8'), { runnerAdmission: admission, detailed: true,
      execution: { executor: run.executionRunner ? { kind: 'ssh', host: run.executionRunner } : { kind: 'local' }, environment: run.environment } });
    result.main = compared.main;
    result.mainComparison = compared;
    if (typeof failureSignatures !== 'function') throw new Refused('MISSING_PORT', 'supply failureSignatures to compare test failures');
    result.failureCases = failureSignatures(run, run.executionRoot ?? root);
    // A file main does not have yet cannot fail there: its failure is new, whatever main's run of it said.
    result.known = (compared.files.length ? compared.files : compared.coarseFiles ?? []).map((entry) => compared.main && spawnSync('git', ['cat-file', '-e', `${compared.main}:${entry.file}`], { cwd: root, env: cleanGitEnvironment(), stdio: 'ignore' }).status !== 0
      ? { ...entry, result: 'absent' } : entry);
    if (compared.unavailable) result.mainUnavailable = compared.unavailable;
  }
  return result;
}
