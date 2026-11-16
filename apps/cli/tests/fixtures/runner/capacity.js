/** A runner runs as many jobs and browser jobs as it was registered with, whatever its own settings say [C7,O5]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listResources,
  takeResource,
} from '../../../../../packages/resources/index.js';
import { runFixtureChild } from '../child.js';
import {
  HOST,
  installSshStandIn,
  shellQuote,
} from './ssh.js';

/** Read one machine pool row through the public resource API, selecting that machine's home. */
function poolAt(machineHome, root, name) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  try { return listResources({ scope: 'machine', root }).find(resource => resource.name === name) ?? null; }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/**
 * Poll an observable fixture state, failing at once with the controller's output if a run exits first.
 * Without the early exit a refused remote setup would only show up as an unexplained timeout.
 */
async function waitForRunState(runs, check, label) {
  const deadline = Date.now() + 60_000; // budget: remote checkout plus admission for four real workers.
  while (true) {
    const state = check();
    if (state) return state;
    for (const run of runs) {
      if (run.result) throw new Error(`${label}: run ${run.item} exited first\n${run.result.stdout.slice(-4_000)}\n${run.result.stderr.slice(-4_000)}`);
    }
    if (Date.now() >= deadline) throw new Error(`${label}: state did not arrive`);
    await new Promise(resolveWait => setTimeout(resolveWait, 20)); // budget: polling interval for a public pool state.
  }
}

/**
 * Register a stand-in runner with 4 slots and 3 browsers, then hold 3 browser runs and 1 plain run on it
 * at once: first with no settings on the runner, then with the runner's own settings at 1 and 1.
 */
export async function runnerUsesRegisteredCapacity(t, { cli, git, observe, startQueueController, gateResult }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-capacity-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const markers = join(dir, 'markers');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome, markers]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const remoteEnv = { ...env, HOME: remoteHome, PULLBOARD_HOME: remoteHome, PULLBOARD_MACHINE_HOME: remoteMachineHome };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare runner capacity fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '4', '--browser', '3', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  const runs = [];
  /** Start one run that holds its runner slot until the test writes its release marker. */
  const startHeld = (item, browser) => {
    const started = join(markers, `${item}.started`);
    const release = join(markers, `${item}.release`);
    const code = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started\\n');
const timer=setInterval(()=>{ if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 5);`;
    const observed = observe(startQueueController(repo, env, `node -e ${shellQuote(code)}`, { item, queueMarker: null, firstItem: null, browser }));
    const run = { item, started, release, ...observed, result: null };
    observed.closed.then(result => { run.result = result; });
    runs.push(run);
    return run;
  };
  /** Hold three browser runs and one plain run on the runner at once, check its pools, then release them green. */
  const holdFour = async (label) => {
    const four = [startHeld(`${label}-b1`, true), startHeld(`${label}-b2`, true), startHeld(`${label}-b3`, true), startHeld(`${label}-plain`, false)];
    await waitForRunState(four, () => four.every(run => existsSync(run.started)), `${label}: all four runs start on the runner at once`);
    const gate = poolAt(remoteMachineHome, repo, 'gate');
    const browser = poolAt(remoteMachineHome, repo, 'browser');
    assert.equal(gate.capacity, 4, `${label}: the runner's gate pool is its registered 4 slots`);
    assert.equal(gate.holders.length, 4, `${label}: four runs hold runner slots`);
    assert.equal(browser.capacity, 3, `${label}: the runner's browser pool is its registered 3 browsers`);
    assert.equal(browser.holders.length, 3, `${label}: three browser runs hold runner browsers`);
    for (const run of four) writeFileSync(run.release, 'release\n');
    for (const result of await Promise.all(four.map(run => run.closed))) {
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.equal(gateResult(result.stdout).runner, HOST, 'the run executed on the runner');
    }
  };
  let held;
  try {
    // Fill the controller's own gate so every run below goes to the runner.
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'local-holder', kind: 'force-registered-runner' });
    await holdFour('unset');
    // The runner machine's own settings neither lower nor raise what its registration gives it.
    for (const [key, value] of [['browserSlots', '1'], ['gateSlots', '1']]) {
      const setting = cli(repo, remoteEnv, 'settings', key, value, '--json');
      assert.equal(setting.status, 0, setting.context);
    }
    await holdFour('lowered');
    const listed = cli(repo, env, 'runner', 'list');
    assert.equal(listed.status, 0, listed.context);
    assert.match(listed.stdout, new RegExp(`^${HOST.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: 4 slots, 3 browser$`, 'mu'), 'runner list prints the registered capacity');
  } finally {
    held?.release();
    for (const run of runs) writeFileSync(run.release, 'cleanup-release\n');
    // A remote setup that never answers must not hold the test file open: stop its controller.
    const settled = Promise.all(runs.map(run => run.closed));
    const ceiling = new Promise(resolveCeiling => { const timer = setTimeout(resolveCeiling, 20_000); timer.unref(); }); // budget: released runs finish well inside this.
    await Promise.race([settled, ceiling]);
    for (const run of runs) if (!run.result) run.child.kill('SIGTERM');
    await settled;
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
}

/** A registered worker enforces timing admission and returns its own sampled load, not the controller's. */
export async function runnerTimingReceipt(t, { cli, git, runThroughGate, gateResult }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-timing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'requests.jsonl');
  for (const folder of [home, machineHome, remoteHome, remoteMachineHome, repo, worker, bin]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = { ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Timing Fixture', GIT_AUTHOR_EMAIL: 'timing@example.invalid',
    GIT_COMMITTER_NAME: 'Timing Fixture', GIT_COMMITTER_EMAIL: 'timing@example.invalid' };
  git(repo, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  git(repo, env, 'add', 'pullboard.json');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare timing worker');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '2', '--browser', '0', '--json');
  assert.equal(added.status, 0, added.context);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let local;
  try {
    local = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo, agent: 'timing-controller-holder' });
    const result = await runThroughGate(repo, env, 'node -e "console.log(\'actual timing worker\')"',
      { timing: true, browser: false, requests, item: 'timing-receipt' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const actual = gateResult(result.stdout);
    assert.equal(actual.runner, HOST);
    const receipt = actual.profile.receipt;
    assert.equal(receipt.runner.id, HOST);
    assert.equal(receipt.runner.kind, 'ssh');
    assert.equal(receipt.runner.slots.current, 2);
    assert.equal(receipt.timing, true);
    assert.equal(receipt.exclusive, true);
    assert.deepEqual(receipt.unfencedClients, []);
    assert.ok(Date.parse(receipt.load.start.at) >= Date.parse(receipt.admittedAt));
    assert.equal(receipt.load.end.at, receipt.finishedAt);
    assert.ok(receipt.load.start.average.every(Number.isFinite));
    assert.ok(receipt.load.end.average.every(Number.isFinite));
  } finally {
    local?.release();
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}
