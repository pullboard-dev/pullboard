/** Busy runner removal stops new dispatches while admitted private jobs finish [C7]. */
import assert from 'node:assert/strict';
import { fixtureMachineSettings } from '../testkit.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { takeResource } from '../../../../../packages/resources/index.js';
import { runFixtureChild } from '../child.js';
import {
  HOST,
  installRegistrationProbeStandIn,
  installSshStandIn,
  shellQuote,
} from './ssh.js';

/** Preserve unrelated settings and the established immediate-removal contract for idle runners. */
export function runnerRemoveKeepsSettings(t, e2e) {
  const box = e2e.project();
  const probeBin = join(box.dir, 'registration-bin');
  mkdirSync(probeBin);
  installRegistrationProbeStandIn({ bin: probeBin });
  box.env.PATH = `${probeBin}:${box.env.PATH}`;
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const removed = { host: 'runner-one.example.invalid', slots: 2, browser: 1, node: 'node', root: '/srv/runner-one' };
  const remaining = { host: 'runner-two.example.invalid', slots: 1, browser: 0 };
  const original = { gateSlots: 3, browserSlots: 2, gate: { shortSlots: 1, runnerDispatch: 'controller', queue: { reviewsFirst: true } },
    relay: { offerAtInit: true }, custom: { keep: 'unchanged' } };
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(original, null, 2));
  const firstAdded = box.run(box.repo, 'runner', 'add', removed.host, '--slots', String(removed.slots), '--browser', String(removed.browser),
    '--node', removed.node, '--root', removed.root, '--json');
  assert.equal(firstAdded.code, 0, firstAdded.err);
  const secondAdded = box.run(box.repo, 'runner', 'add', remaining.host, '--slots', String(remaining.slots), '--browser', String(remaining.browser), '--json');
  assert.equal(secondAdded.code, 0, secondAdded.err);
  removed.gui = JSON.parse(firstAdded.out).runner.gui;
  remaining.gui = JSON.parse(secondAdded.out).runner.gui;
  remaining.node = JSON.parse(secondAdded.out).runner.node;
  assert.equal(remaining.node, process.execPath, 'registration discovers the worker Node path before removal');
  removed.cores = JSON.parse(firstAdded.out).runner.cores;
  remaining.cores = JSON.parse(secondAdded.out).runner.cores;
  removed.memoryMB = JSON.parse(firstAdded.out).runner.memoryMB;
  remaining.memoryMB = JSON.parse(secondAdded.out).runner.memoryMB;
  removed.measuredAt = JSON.parse(firstAdded.out).runner.measuredAt;
  remaining.measuredAt = JSON.parse(secondAdded.out).runner.measuredAt;
  removed.publicKey = JSON.parse(firstAdded.out).runner.publicKey;
  remaining.publicKey = JSON.parse(secondAdded.out).runner.publicKey;
  assert.match(removed.publicKey, /^[A-Za-z0-9_-]{40,}$/u, 'registration enrols the runner\'s Ed25519 public key');
  assert.match(remaining.publicKey, /^[A-Za-z0-9_-]{40,}$/u, 'registration enrols the runner\'s Ed25519 public key');
  assert.notEqual(removed.publicKey, remaining.publicKey, 'each registered runner enrols its own key');
  removed.fixed = true;
  remaining.fixed = true;
  assert.ok([true, false, null].includes(removed.gui));
  assert.ok([true, false, null].includes(remaining.gui));
  const registered = { ...original, runners: [removed, remaining] };
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), registered);

  const result = box.run(box.repo, 'runner', 'remove', removed.host);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(`removed runner ${removed.host}`), result.out);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { ...original, runners: [remaining] });

  const missing = box.run(box.repo, 'runner', 'remove', removed.host, '--json');
  assert.equal(missing.code, 1, missing.err);
  const refusal = JSON.parse(missing.out).error;
  assert.equal(refusal.code, 'RUNNER_NOT_REGISTERED');
  assert.ok(refusal.next.includes(remaining.host), refusal.next);
  assert.ok(!refusal.next.includes(removed.host), refusal.next);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { ...original, runners: [remaining] });
}

/** Wait for a visible private-job state, reporting an early controller failure rather than timing out. */
async function waitFor(runs, check, label) {
  const deadline = Date.now() + 60_000; // budget: source setup and two private SSH stand-in jobs.
  while (!check()) {
    for (const run of runs) if (run.result && run.result.status !== 0) {
      throw new Error(`${label}: ${run.item} failed\n${run.result.stdout}\n${run.result.stderr}`);
    }
    assert.ok(Date.now() < deadline, label);
    await new Promise(done => setTimeout(done, 20)); // budget: private state observation only.
  }
}

/** Removing a runner with two real admitted jobs drains them and sends later work to the local executor. */
export async function removingBusyRunnerDrains(t, { cli, git, observe, startQueueController, gateResult }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-drain-')));
  const repo = join(directory, 'repo'), home = join(directory, 'home');
  const machineHome = join(home, '.pullboard'), remoteHome = join(directory, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard'), worker = join(directory, 'worker');
  const bin = join(directory, 'bin'), markers = join(directory, 'markers');
  for (const path of [repo, home, machineHome, remoteHome, remoteMachineHome, worker, bin, markers]) mkdirSync(path, { recursive: true });
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Drain Fixture', GIT_AUTHOR_EMAIL: 'runner-drain@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Drain Fixture', GIT_COMMITTER_EMAIL: 'runner-drain@example.invalid' };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'private runner drain source\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare runner drain fixture');
  // The stand-in worker's own machine home pins controller dispatch too [P7].
  fixtureMachineSettings(remoteMachineHome, { gate: { runnerDispatch: 'controller' } });
  fixtureMachineSettings(machineHome, { gateSlots: 1, browserSlots: 1, gate: { runnerDispatch: 'controller' }, custom: { preserve: true } });
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests: join(directory, 'ssh-requests.jsonl') });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '2', '--browser', '0', '--json');
  assert.equal(added.status, 0, added.context);
  const previousHome = process.env.PULLBOARD_HOME, previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  const runs = [];
  let local;
  /** Launch one ordinary production runner round trip, holding its child command on a private release file. */
  function start(item, queueMarker = null) {
    const started = join(markers, `${item}.started`), release = join(markers, `${item}.release`);
    const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10);`;
    const run = { item, started, release, ...observe(startQueueController(repo, env, `node -e ${shellQuote(code)}`, { item, browser: false, queueMarker, firstItem: null })), result: null };
    run.closed.then(result => { run.result = result; });
    runs.push(run);
    return run;
  }
  /** Read the public runner list from this isolated machine, through the real CLI. */
  function listed() {
    const result = cli(repo, env, 'runner', 'list', '--json');
    assert.equal(result.status, 0, result.context);
    return JSON.parse(result.stdout).runners;
  }
  try {
    local = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo, agent: 'drain-local-holder', kind: 'fixture' });
    const first = start('first'), second = start('second');
    await waitFor(runs, () => [first, second].every(run => existsSync(run.started)), 'both jobs start on the two-slot runner');
    const removed = cli(repo, env, 'runner', 'remove', HOST, '--json');
    assert.equal(removed.status, 0, removed.context);
    assert.equal(JSON.parse(removed.stdout).runner.draining, true, 'busy remove succeeds and declares draining');
    assert.equal(listed().find(runner => runner.host === HOST)?.draining, true, 'runner list keeps the active draining host visible');
    assert.equal(JSON.parse(readFileSync(join(machineHome, 'settings.json'), 'utf8')).custom.preserve, true);
    const thirdQueued = join(markers, 'third.queued');
    const third = start('third', thirdQueued);
    await waitFor(runs, () => existsSync(thirdQueued), 'the post-remove job joins the queue while the local and remote slots are occupied');
    writeFileSync(first.release, 'release');
    const firstResult = await first.closed;
    assert.equal(firstResult.status, 0, `${firstResult.stdout}${firstResult.stderr}`);
    assert.equal(gateResult(firstResult.stdout).runner, HOST, 'the first admitted job finishes on the removed runner');
    await waitFor(runs, () => listed().find(runner => runner.host === HOST)?.inUse === 1, 'the second job keeps the host draining after the first releases');
    assert.equal(existsSync(third.started), false, 'later work has not taken the now-free draining runner slot');
    local.release(); local = null;
    await waitFor(runs, () => existsSync(third.started), 'later work starts locally while the second remote job remains held');
    writeFileSync(third.release, 'release');
    const thirdResult = await third.closed;
    assert.equal(thirdResult.status, 0, `${thirdResult.stdout}${thirdResult.stderr}`);
    assert.equal(gateResult(thirdResult.stdout).runner, undefined, 'the post-remove job runs locally without a remote execution receipt');
    writeFileSync(second.release, 'release');
    const secondResult = await second.closed;
    assert.equal(secondResult.status, 0, `${secondResult.stdout}${secondResult.stderr}`);
    assert.equal(gateResult(secondResult.stdout).runner, HOST, 'the second admitted job also finishes normally');
    assert.ok(!listed().some(runner => runner.host === HOST), 'the runner leaves the list after its final job ends');
    const registeredAgain = cli(repo, env, 'runner', 'add', HOST, '--slots', '2', '--browser', '0', '--json');
    assert.equal(registeredAgain.status, 0, registeredAgain.context);
    assert.ok(listed().some(runner => runner.host === HOST && !runner.draining), 'explicit re-registration clears the drain state');
    const idleRemove = cli(repo, env, 'runner', 'remove', HOST, '--json');
    assert.equal(idleRemove.status, 0, idleRemove.context);
    assert.ok(!listed().some(runner => runner.host === HOST), 'an idle runner still disappears immediately');
  } finally {
    local?.release();
    for (const run of runs) writeFileSync(run.release, 'cleanup-release');
    const settled = Promise.all(runs.map(run => run.closed));
    const ceiling = new Promise(done => { const timer = setTimeout(done, 20_000); timer.unref(); }); // budget: already-released private workers finish in this window.
    await Promise.race([settled, ceiling]);
    for (const run of runs) if (!run.result) run.child.kill('SIGTERM');
    await settled;
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
    rmSync(directory, { recursive: true, force: true });
  }
}
