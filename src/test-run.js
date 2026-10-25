/** pullboard test: named test files on the runner pool, with the focused runner's per-file timeout [C7]. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { testsNeedBrowser } from './browser-admission.js';
import { selectAffectedTests } from './affected-tests.js';
import { selectRegistryGuards } from './registry-guards.js';
import { mainPolicy } from './trusted-policy-read.js';
import {
  runProfiledShellAsync,
  withGateSlot,
} from './gate.js';
import {
  cleanGitEnvironment,
  headCommit,
} from './git.js';
import {
  projectNeedsGui,
  testsNeedGui,
} from './gui-admission.js';
import {
  compareMainFailures,
  withMainCheckout,
} from './main-red.js';
import { Refused } from './refused.js';
import { runnerSource } from './runners.js';
import {
  browserFreeChecksEnabled,
  gateRunnersFirstEnabled,
  loadMachineSettings,
} from './settings.js';

/** Quote one argument for the configured focused test command. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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
 * The commit a runner checks out: HEAD when the tree is clean, else a snapshot commit of the working tree, made
 * with a private index so the checkout's own index and branches stay as they are. Ignored files stay out.
 */
function snapshotCommit(root) {
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
async function inCleanCheckout(root, work) {
  const { commit, clean } = snapshotCommit(root);
  if (clean) return work(root);
  const result = await withMainCheckout(root, commit, work);
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
 * Run named test files through a gate slot, which deals them to the registered runners first (#1054); the focused
 * runner (pullboard.json affectedTests) gives each file its timeout. A red file is compared with main's recorded
 * result for that file, so a failure main already has reads as known.
 *
 * @returns {Promise<{ green: boolean, output: string, runner: string, seconds: number, files: string[], known: Array<{file: string, result: string}>, main: string|null }>}
 */
export async function runTestFiles(root, config, files, { agent, onWait, affected = false } = {}) {
  if (affected && files.length) throw new Refused('USAGE', 'use pullboard test --affected without file arguments, or name the files without --affected');
  const policy = affected ? mainPolicy(root) : null;
  if (policy) config = policy.config;
  if (typeof config.affectedTests !== 'string' || !config.affectedTests.trim()) {
    throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node bin/run-tests.js"');
  }
  let paths = affected ? [] : testFiles(root, files);
  const started = Date.now();
  const run = await inCleanCheckout(root, async (checkout) => {
    let full = false;
    if (policy) {
      const options = { base: policy.commit, trunk: policy.commit };
      const selection = selectAffectedTests(checkout, options);
      const guards = selectRegistryGuards(checkout, config.registryGuards, options);
      full = selection.full;
      paths = [...new Set([...(full ? [] : selection.files), ...guards])].sort();
      if (paths.length) paths = testFiles(checkout, paths);
    }
    const focused = paths.length ? `${config.affectedTests.trimEnd()} ${paths.map(path => shellWord('./' + path)).join(' ')}` : '';
    if (full && !config.gate?.trim()) throw new Refused('NO_TEST_RUNNER', 'affected selection needs the full project gate; set gate in accepted pullboard.json');
    const command = full ? `(${config.gate})${focused ? ' && ' + focused : ''}` : (focused || 'true');
    const browser = full || !browserFreeChecksEnabled() || await testsNeedBrowser(checkout, paths);
    return withGateSlot(checkout, (lease) => runProfiledShellAsync(checkout, command, { gateLease: lease, waitMs: lease.waitMs }),
      { browser, gui: (full && projectNeedsGui(checkout)) || testsNeedGui(checkout, paths), shortEligible: !full, agent, kind: 'test', onWait });
  });
  const result = { green: run.isGreen, output: run.output, runner: run.executionRunner || 'this machine', seconds: Math.round((Date.now() - started) / 1000), files: paths, known: [], main: null,
    ...(run.executionRunner ? {} : { local: localReason() }) };
  if (!run.isGreen) {
    const compared = await compareMainFailures(root, run.profile, onWait, run.output);
    result.main = compared.main;
    // A file main does not have yet cannot fail there: its failure is new, whatever main's run of it said.
    result.known = compared.files.map((entry) => compared.main && spawnSync('git', ['cat-file', '-e', `${compared.main}:${entry.file}`], { cwd: root, env: cleanGitEnvironment(), stdio: 'ignore' }).status !== 0
      ? { ...entry, result: 'absent' } : entry);
    if (compared.unavailable) result.mainUnavailable = compared.unavailable;
  }
  return result;
}
