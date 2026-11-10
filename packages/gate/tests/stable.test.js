// pullboard: browser
/** @pullboard-test-gui */
/** A test Chrome never outlives the test that started it: every launcher ties Chrome to its owner [C7]. */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RUNNER_PID_ENV,
  findChromeExecutable,
  findRunnerAncestor,
} from '../../../apps/cli/tests/fixtures/chrome.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROBE = join(ROOT, 'packages/gate/tests/fixtures/cockpit/probe.mjs');
const DEATH_BUDGET_MS = 10_000; // budget: the item's declared bound for Chrome to exit after its owner dies.
const READY_BUDGET_MS = 600_000; // budget: hang ceiling for one real Chrome launch, including a wait for a gate browser slot.

/** The launchers the tests use, by the name the probe file takes. */
const LAUNCHERS = {
  startChrome: 'startChrome in apps/cli/tests/fixtures/chrome.js (relay, seal, journeys, README capture, perf)',
  launchChromeProcess: 'launchChromeProcess in apps/cli/tests/fixtures/chrome.js',
  openSnapshotChrome: 'openSnapshotChrome in apps/cli/tests/fixtures/cockpit/harness.js (every cockpit story)',
};

/**
 * List the live processes of one Chrome by its private profile path.
 * The profile path is unique to this test, so nothing else matches it.
 */
function chromeProcesses(profile) {
  const rows = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return rows.split('\n').filter((row) => row.includes(`--user-data-dir=${profile}`))
    .map((row) => row.trim().split(/\s+/u)).map(([pid, pgid]) => ({ pid: Number(pid), pgid: Number(pgid) }));
}

/** Wait for the probe's ready file, failing early if the process that should write it has ended. */
async function waitForReady(file, child, budgetMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < budgetMs) {
    if (existsSync(file)) return Number(readFileSync(file, 'utf8'));
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('the owner ended before Chrome was ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Chrome was not ready within ${budgetMs}ms`);
}

/** Wait until no process of this Chrome remains, returning the elapsed milliseconds, or null when the budget passes. */
async function waitForChromeGone(profile, budgetMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < budgetMs) {
    if (chromeProcesses(profile).length === 0) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return chromeProcesses(profile).length === 0 ? Date.now() - startedAt : null;
}

/** Stop only the process groups and pids this test recorded, never anything found by name. */
function stopRecorded(profile, pids) {
  for (const { pgid } of chromeProcesses(profile)) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* Already gone. */ } }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
}

test('a test finds its runner by the pid the runner gave it, never by its command line [C7]', () => {
  // A parent chain this process -> 700 -> 600 -> 500 -> 1, as ps would report it.
  const chain = new Map([[process.pid, 700], [700, 600], [600, 500], [500, 1]]);
  const parentOf = (pid) => chain.get(pid) ?? null;
  assert.equal(findRunnerAncestor({ env: { [RUNNER_PID_ENV]: '600' }, parentOf }), 600, 'the named runner is found up the chain');
  assert.equal(findRunnerAncestor({ env: { [RUNNER_PID_ENV]: '900' }, parentOf }), null, 'a pid that is not an ancestor is never guarded');
  assert.equal(findRunnerAncestor({ env: {}, parentOf }), null, 'with no runner, only the owner is guarded');
  assert.equal(findRunnerAncestor({ env: { [RUNNER_PID_ENV]: '1' }, parentOf }), null, 'init is never a runner');
});

/** How each killed process starts the probe: the owner directly, or the runner, with and without its own options. */
const VICTIMS = {
  owner: [],
  runner: ['packages/gate/src/io/run/tests.js'],
  'runner started with --test-concurrency=1': ['packages/gate/src/io/run/tests.js', '--test-concurrency=1'],
  // A data: import before the runner, which no reading of ps text tells from a worker (#896).
  'runner started after a data: import': ['--import', 'data:text/javascript,globalThis.__probe=1', 'packages/gate/src/io/run/tests.js'],
};

for (const [launcher, name] of Object.entries(LAUNCHERS)) {
  for (const killed of Object.keys(VICTIMS)) {
    test(`Chrome from ${name} exits within 10 s of its ${killed} dying by SIGKILL [C7]`, {
      timeout: READY_BUDGET_MS + DEATH_BUDGET_MS + 30_000,
      skip: !findChromeExecutable() && 'Chrome is not installed',
    }, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'pullboard-owner-death-'));
      const profile = join(directory, 'profile');
      const readyFile = join(directory, 'ready');
      const recorded = [];
      t.after(() => { stopRecorded(profile, recorded); rmSync(directory, { recursive: true, force: true }); });
      const env = { ...process.env, PROBE_LAUNCHER: launcher, PROBE_PROFILE: profile, PROBE_READY: readyFile };
      // The runner case starts the probe the way the gate does, as a test file under packages/gate/src/io/run/tests.js.
      const victim = killed === 'owner'
        ? spawn(process.execPath, [PROBE], { cwd: ROOT, env, stdio: 'ignore' })
        : spawn(process.execPath, [...VICTIMS[killed], 'packages/gate/tests/fixtures/cockpit/probe.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
      recorded.push(victim.pid);
      recorded.push(await waitForReady(readyFile, victim, READY_BUDGET_MS)); // budget: hang ceiling for Chrome to start, including a gate browser-slot wait; no speed claim.
      const before = chromeProcesses(profile);
      assert.ok(before.length > 0, 'the owner holds a live Chrome before it is killed');
      const ended = new Promise((resolve) => victim.once('exit', (code, signal) => resolve(signal)));
      process.kill(victim.pid, 'SIGKILL');
      assert.equal(await ended, 'SIGKILL', `the ${killed} died by SIGKILL`);
      const gone = await waitForChromeGone(profile, DEATH_BUDGET_MS); // budget: the item's declared bound on Chrome outliving its dead owner.
      assert.notEqual(gone, null, `Chrome (${before.length} processes, pids ${before.map(row => row.pid).join(',')}) survived its ${killed} for ${DEATH_BUDGET_MS}ms`); // budget: the item's declared 10 s bound.
    });
  }
}
