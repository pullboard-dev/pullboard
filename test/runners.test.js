/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
import assert from 'node:assert/strict';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { gateSlotEnvironment, listResources, setResourceCapacity, takeResource } from '../src/resources.js';
import { parseProcessCensus } from '../src/process-census.js';
import { listResources as listPreRunnerResources, takeResource as takePreRunnerResource } from './fixtures/resources-pre-runners.js';
import { cleanupFixtureChildren, runFixtureChild, runFixtureChildAsync, startFixtureChild } from './fixture-child.js';
import { readRemoteGateHolders, waitForCondition } from './runner-fixture-state.js';
import { assertAttemptDeadlineReset, assertRedispatchDeadlineAccounting, runPairedRerun, startRunnerCpuStandIn } from './runner-paired-rerun-fixture.js';
import { assertFixtureGroupEpermControls, stopGroup } from './runner-process-group.js';
import { parentDeathDrainFixture } from './runner-parent-death-fixture.js';
import { runnerOrphanFixture, unprovenProcessFixture } from './runner-orphan-fixture.js';
import { createDescendantTracker } from '../src/runner-custody.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { refuseSandboxBlocked } from '../src/gate.js';
import { SECRET, HOST, shellQuote, installSshStandIn } from './runner-ssh-fixture.js';
import { sourceSetupFailureFixture } from './runner-source-setup-fixture.js';
import { runnerSourceRefusalCases } from './runner-source-refusal-fixture.js';
import { writeCacheProbe, writeProbe } from './runner-probe-fixture.js';
import { browserFreeRunnerCheck, browserRefusalTextStaysRed } from './runner-browser-free-fixture.js';
import { runnerTimingReceipt, runnerUsesRegisteredCapacity } from './runner-capacity-fixture.js';
import { runnerFirstPolicyCase } from './runner-first-fixture.js';
import { removingBusyRunnerDrains, runnerRemoveKeepsSettings } from './runner-drain-fixture.js';
import { awaitRoundTrip, cleanupToolingSnapshots, cli, committedToolingSnapshot, fixtureResultContext, gateResult, git, phaseCounts, ROUND_TRIP_DEADLINES, runThroughGate, startToolingCli, TOOLING_SNAPSHOTS } from './runner-tooling-fixture.js';
import { runnerStageFixture } from './runner-stage-fixture.js';
import { privateReviewRunnerCase, privateReviewRunnerEdges } from './runner-private-check-fixture.js';

const PAIRED_RERUN_FIXTURE = { createE2eHelpers, cli, observe, startToolingCli, awaitRoundTrip, phaseCounts,
  ROUND_TRIP_DEADLINES, HOST, shellQuote, installSshStandIn, processesUnder, stopGroup };

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP = [];
const e2e = createE2eHelpers();
after(e2e.cleanup);
after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

/** Wait for the marker itself: a missed file notification must not hide observable readiness. */
async function waitForMarker(path) {
  const deadline = Date.now() + 20_000; // budget: unchanged hang ceiling for the queue-to-parent handoff.
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`fixture marker did not arrive: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20)); // budget: polling interval for the actual readiness marker.
  }
}

/** Check exact PID presence without signalling or treating permission denial as absence. */
function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** Start an API child that requeues only an incomplete runner transport on its original ticket. */
function startQueueController(repo, env, command, { item, queueMarker, firstItem = 'retry-first', remote = true, browser = true, toolingRoot = resolve(import.meta.dirname, '..') } = {}) {
  const sourceRoot = realpathSync(toolingRoot);
  const gateUrl = pathToFileURL(join(committedToolingSnapshot(sourceRoot, env), 'src', 'gate.js')).href;
  const snapshot = TOOLING_SNAPSHOTS.get(sourceRoot);
  snapshot.active++;
  const script = `import { writeFileSync } from 'node:fs';
const { runProfiledShell, withGateSlot } = await import(${JSON.stringify(gateUrl)});
const root = ${JSON.stringify(repo)};
const command = ${JSON.stringify(command)};
const queueMarker = ${JSON.stringify(queueMarker)};
const firstItem = ${JSON.stringify(firstItem)};
const result = await withGateSlot(root, async lease => {
  const run = await runProfiledShell(root, command, { gateLease: lease });
  process.stdout.write(run.output);
  process.stdout.write('PULLBOARD_RUN_RESULT ' + JSON.stringify({ isGreen: run.isGreen, runner: run.profile.executionRunner }) + '\\n');
  return run;
},
  { browser: ${browser}, remote: ${remote}, item: ${JSON.stringify(item)}, kind: 'runner-retry-test', agent: ${JSON.stringify(item)},
  onWait(state) {
    const rows = state.line ?? [];
    if (queueMarker && rows.some(row => row.item === ${JSON.stringify(item)}) && (firstItem === null || rows.some(row => row.item === firstItem))) {
      writeFileSync(${JSON.stringify(queueMarker)}, 'both retry tickets are queued\\n');
    }
  }
});
process.exitCode = result.isGreen ? 0 : 1;
`;
  try {
    const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const finish = (status, signal, failed) => {
      if (settled) return;
      settled = true;
      snapshot.active--;
      if (failed || status !== 0 || signal) snapshot.retained = true;
    };
    child.once('close', (status, signal) => finish(status, signal, false));
    child.once('error', () => finish(null, null, true));
    return child;
  } catch (error) {
    snapshot.active--;
    snapshot.retained = true;
    throw error;
  }
}

/** Observe a running fixture child without hiding stdout, stderr, or its exit status. */
function observe(child) {
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = once(child, 'close').then(([status, signal]) => ({ status, signal, stdout, stderr }));
  return { child, closed };
}

test('a review check runs on a runner at the exact commit with trusted policy and full artifacts [C7,V4]', (t) => privateReviewRunnerCase(t, e2e));

test('private runner install, deadline and guard edges preserve public review behavior [C7,V4]', (t) => privateReviewRunnerEdges(t, e2e));

test("the runner's trusted runtime list is closed under its relative imports [C7,O5]", () => {
  const src = resolve(import.meta.dirname, '../src');
  /** Read a runtime list literal from its source file, so the test sees exactly what ships. */
  const listIn = (file, pattern) => {
    const found = pattern.exec(readFileSync(join(src, file), 'utf8'));
    assert.ok(found, `${file} declares the runner runtime list`);
    return JSON.parse(found[1].replaceAll("'", '"'));
  };
  const controller = listIn('runners.js', /const RUNTIME_NAMES = (\[[^\]]*\]);/u);
  const worker = listIn('runner-worker.js', /const runtimeNames = (\[[^\]]*\]);/u);
  assert.deepEqual([...worker].sort(), [...controller].sort(), 'the controller ships the files the worker expects');
  // Every relative import of a shipped file (and of the worker itself) must ship too, or it fails on the runner.
  for (const file of [...controller, 'runner-worker.js']) {
    const text = readFileSync(join(src, file), 'utf8');
    const imports = [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)'(\.\/[^']+)'/gmu)].map(([, path]) => basename(path));
    for (const name of imports) {
      assert.ok(controller.includes(name), `${file} imports ./${name}, which the runner runtime list does not ship`);
    }
  }
});

test('runner remove deletes one runner and keeps the rest [C7]', (t) => runnerRemoveKeepsSettings(t, e2e));

test('removing a busy runner drains it [C7]', (t) => removingBusyRunnerDrains(t, { cli, git, observe, startQueueController, gateResult }));

test('a queued run executes on a registered runner and its result comes back (host checkout isolation) [C7]', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-tooling-isolation-')));
  let completedCleanly = false;
  t.after(() => {
    if (!completedCleanly) {
      t.diagnostic('retained runner tooling isolation fixture at ' + dir);
      return;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const remoteStateRoot = join(remoteHome, '.pullboard-runner');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const toolingRoot = join(dir, 'owned-tooling');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome, remoteStateRoot, toolingRoot]) {
    mkdirSync(folder, { recursive: true });
  }
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: bin + ':' + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Tooling Isolation Fixture', GIT_AUTHOR_EMAIL: 'runner-tooling-isolation@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Tooling Isolation Fixture', GIT_COMMITTER_EMAIL: 'runner-tooling-isolation@example.invalid',
  };
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'host checkout isolation fixture\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare host checkout isolation fixture');

  const suiteRoot = resolve(import.meta.dirname, '..');
  copyFileSync(join(suiteRoot, 'package.json'), join(toolingRoot, 'package.json'));
  cpSync(join(suiteRoot, 'src'), join(toolingRoot, 'src'), { recursive: true });
  cpSync(join(suiteRoot, 'bin'), join(toolingRoot, 'bin'), { recursive: true });
  git(toolingRoot, env, 'init', '-q', '-b', 'main');
  git(toolingRoot, env, 'add', 'package.json', 'src', 'bin');
  git(toolingRoot, env, 'commit', '-q', '-m', 'test: commit current tooling bytes');
  const ownedCommit = git(toolingRoot, env, 'rev-parse', 'HEAD');
  writeFileSync(join(toolingRoot, 'LOCAL-NOTE.txt'), 'unrelated local note\n');
  assert.match(git(toolingRoot, env, 'status', '--porcelain'), /^\?\? LOCAL-NOTE\.txt$/u);
  const cleanToolingRoot = committedToolingSnapshot(toolingRoot, env);

  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  const command = `node -e ${shellQuote('process.stdout.write("HOST_CHECKOUT_ISOLATED\\n")')}`;
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'tooling-isolation-local-holder', item: 'tooling-isolation-local-holder', kind: 'force-registered-runner' });
    const run = await runThroughGate(repo, env, command, { item: 'tooling-isolation', toolingRoot, requests });
    assert.equal(run.status, 0, fixtureResultContext(run));
    assert.match(run.stdout, /HOST_CHECKOUT_ISOLATED/u);
    const result = gateResult(run.stdout);
    assert.equal(result.isGreen, true);
    assert.equal(result.runner, HOST);
    assert.deepEqual(result.profile.receipt.environment, { platform: process.platform, arch: process.arch, node: process.versions.node },
      'the real SSH stand-in worker reports its own executor, without inferring a second physical host');
    assert.equal(result.profile.executionRunner, HOST);
    assert.equal(result.profile.executionSource.tooling.name, 'pullboard');
    assert.equal(result.profile.executionSource.tooling.kind, 'git-checkout');
    assert.equal(result.profile.executionSource.tooling.commit, git(cleanToolingRoot, env, 'rev-parse', 'HEAD'),
      'the execution imports its clean private tooling snapshot, not the unrelated-note checkout');
    assert.notEqual(result.profile.executionSource.tooling.commit, ownedCommit);
    const requestsSeen = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    assert.equal(requestsSeen.length, 1, 'the actual remote command is sent exactly once');
    assert.equal(requestsSeen[0].host, HOST);
    assert.equal(requestsSeen[0].workerStarted, true);
    assert.equal(requestsSeen[0].code, 0);
    const cliBefore = phaseCounts(`${requests}.phases`);
    const cliRun = observe(startToolingCli(repo, env, ['gate', '--json'], { toolingRoot, detached: true }));
    const cliResult = await awaitRoundTrip(cliRun.child, cliRun.closed, `${requests}.phases`, cliBefore);
    assert.equal(cliResult.status, 0, fixtureResultContext(cliResult));
    assert.equal(JSON.parse(cliResult.stdout.trim()).green, true);
    const allRequests = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    assert.equal(allRequests.length, 2, 'both the API and actual CLI execute remotely from clean tooling snapshots');
    assert.ok(allRequests.every(request => request.host === HOST && request.workerStarted && request.code === 0));
    assert.equal(git(toolingRoot, env, 'status', '--porcelain'), '?? LOCAL-NOTE.txt',
      'the owned source fixture remains dirty only by its unrelated note');
    completedCleanly = true;
  } finally {
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a private check never refuses its own remote lease [C7,V4]', async (t) => {
  // The frozen check records the local gate marker it ran under, so a verdict proves the check itself ran.
  const box = e2e.privateCheckSubmission({ check: `printf 'held=%s pool=%s' "$PULLBOARD_GATE_SLOT_HELD" "$PULLBOARD_GATE_SLOT_POOL" > "$RUNNER_FIXTURE_CHECK_MARKER"` });
  const home = join(box.dir, 'home');
  const remoteHome = join(box.dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const worker = join(box.dir, 'second-machine');
  const bin = join(box.dir, 'ssh-bin');
  const requests = join(box.dir, 'ssh-requests.jsonl');
  const marker = join(box.dir, 'check-ran');
  for (const folder of [home, remoteHome, remoteMachineHome, join(remoteHome, '.pullboard-runner'), worker, bin, box.env.PULLBOARD_MACHINE_HOME]) {
    mkdirSync(folder, { recursive: true });
  }
  const env = { ...box.env, HOME: home, PATH: bin + ':' + box.env.PATH, RUNNER_FIXTURE_CHECK_MARKER: marker };
  // The suite runs under its own gate lease; the review must take and mark a lease of its own.
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const machineHome = env.PULLBOARD_MACHINE_HOME;
  const settingsFile = join(machineHome, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  writeFileSync(settingsFile, JSON.stringify({ ...settings, gateSlots: 1 }));
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(box.repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  let review;
  try {
    // Filling the only local slot is what sends a remote-capable waiter to the runner.
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: box.repo,
      agent: 'private-check-local-holder', item: 'private-check-local-holder', kind: 'force-registered-runner' });
    review = observe(startFixtureChild(process.execPath, [BIN, 'verify', '1', 'accept', '--note', 'the frozen check ran to a verdict', '--json'], {
      cwd: box.review, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    let exited = null;
    review.closed.then(result => { exited = result; });
    /** Read the review's ticket in this machine's gate line, if it is waiting there. */
    const reviewTicket = () => listResources({ scope: 'machine', root: box.repo })
      .find(resource => resource.name === 'gate')?.line.find(entry => entry.item === '1' && entry.kind === 'review');
    const deadline = Date.now() + 20_000; // budget: hang ceiling for the review to reach the gate line.
    while (!exited && !reviewTicket()) {
      if (Date.now() >= deadline) throw new Error('the review neither queued nor finished');
      await new Promise(resolve => setTimeout(resolve, 40)); // budget: polling interval for the observable queue state.
    }
    const early = exited ? `${exited.stdout}\n${exited.stderr}` : '';
    assert.doesNotMatch(early, /REMOTE_GATE_SLOT_NOT_INHERITABLE/, 'the review refused its own runner lease before its frozen check ran');
    assert.equal(exited, null, `the review finished while the only local slot was held: ${early}`);
    assert.equal(reviewTicket().remote, undefined, 'the private check queues for a local slot only, never the runner');

    const command = `node -e ${shellQuote('process.stdout.write("GATE_ON_RUNNER\\n")')}`;
    // The round trip's phase deadlines bound a broken fixture-only remote dispatch.
    const gate = await runThroughGate(box.repo, env, command, { item: 'private-check-gate', requests });
    assert.equal(gate.status, 0, `a gate run still dispatches to the runner while the review waits: ${fixtureResultContext(gate)}`);
    assert.match(gate.stdout, /GATE_ON_RUNNER/u);
    assert.equal(gateResult(gate.stdout).runner, HOST, 'the gate run executed on the registered runner');
    assert.equal(exited, null, 'the review still waits for its local slot after the runner run');

    held.release();
    held = undefined;
    const finished = await review.closed;
    assert.doesNotMatch(`${finished.stdout}\n${finished.stderr}`, /REMOTE_GATE_SLOT_NOT_INHERITABLE/);
    assert.equal(finished.status, 0, `the review reached a verdict: ${finished.stdout}\n${finished.stderr}`);
    assert.equal(readFileSync(marker, 'utf8'), `held=1 pool=${realpathSync(join(machineHome, 'resources.sqlite'))}`, 'the frozen check ran locally under the review\'s own local gate lease');
    assert.equal(JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_status, 'verified');
    const requestsSeen = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(requestsSeen.map(request => request.host), [HOST], 'only the gate run reached the runner');

    // The refusal still guards its real case: a runner lease never becomes local child markers.
    assert.throws(() => gateSlotEnvironment({ name: 'gate', scope: 'machine', pool: 'fixture-pool', token: 'fixture-token', runner: { host: HOST } }),
      error => error.code === 'REMOTE_GATE_SLOT_NOT_INHERITABLE');
  } finally {
    if (held) held.release();
    if (review && review.child.exitCode === null && review.child.signalCode === null) review.child.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('current source refuses private, oversized and unsupported blobs before SSH [C7,S1]', runnerSourceRefusalCases);

test('a queued run executes on a registered runner and its result comes back [C7]', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-')));
  TEMP.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteStateRoot = join(remoteHome, '.pullboard-runner');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, home, remoteHome, remoteStateRoot, remoteMachineHome, machineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env,
    HOME: home,
    PULLBOARD_HOME: home,
    PULLBOARD_MACHINE_HOME: machineHome,
    PULLBOARD_GATE_SLOT_HELD: '1',
    PULLBOARD_GATE_SLOT_POOL: 'caller-pool-marker',
    PULLBOARD_GATE_SLOT_TOKEN: 'caller-token-marker',
    PULLBOARD_BROWSER_SLOT_HELD: '1',
    PULLBOARD_RUNNER_FIXTURE_SECRET: SECRET,
    SSH_AUTH_SOCK: join(dir, 'must-not-forward.sock'),
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture',
    GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture',
    GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  writeFileSync(join(repo, 'empty.bin'), Buffer.alloc(0));
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 10, 255, 13, 0, 128]));
  writeFileSync(join(repo, 'history-original.txt'), 'committed history witness\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'tracked.txt', 'history-original.txt', 'empty.bin', 'binary.bin');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare registered runner fixture');
  const historyBaseCommit = git(repo, env, 'rev-parse', 'HEAD');
  git(repo, env, 'tag', '-a', 'runner-release', '-m', 'runner release annotation witness', historyBaseCommit);
  git(repo, env, 'tag', 'runner-lightweight', historyBaseCommit);
  const annotatedTagObject = git(repo, env, 'rev-parse', 'refs/tags/runner-release');
  const lightweightTagObject = git(repo, env, 'rev-parse', 'refs/tags/runner-lightweight');
  const unrelatedCommit = git(repo, env, 'commit-tree', `${historyBaseCommit}^{tree}`, '-m', 'unrelated tag target');
  git(repo, env, 'tag', 'runner-unrelated', unrelatedCommit);
  git(repo, env, 'mv', 'history-original.txt', 'history-renamed.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: preserve renamed runner history witness');
  writeFileSync(join(repo, '.env'), SECRET);
  const commit = git(repo, env, 'rev-parse', 'HEAD');
  const tree = git(repo, env, 'rev-parse', 'HEAD^{tree}');
  assert.equal(git(repo, env, 'status', '--porcelain'), '', 'the ignored secret is not a dirty tracked change');

  const ssh = installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  assert.ok(existsSync(ssh));
  writeProbe(repo, { remoteStateRoot, remoteMachineHome, sourceHome: home, sourceMachineHome: machineHome, historyBaseCommit,
    annotatedTagObject, lightweightTagObject,
    callerPool: 'caller-pool-marker', callerToken: 'caller-token-marker' });
  git(repo, env, 'add', 'runner-probe.test.js');
  git(repo, env, 'commit', '-q', '-m', 'test: add remote source probe [C7]');
  const selectedCommit = git(repo, env, 'rev-parse', 'HEAD');
  const selectedTree = git(repo, env, 'rev-parse', 'HEAD^{tree}');

  // This is the first behavior checked: on the old implementation the real CLI rejects `runner add`
  // before any new runner module/import is reached, giving a meaningful old-source red.
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  const resources = cli(repo, env, 'resources', '--json');
  assert.equal(resources.status, 0, resources.context);
  const listed = JSON.parse(resources.stdout);
  assert.ok(listed.runners?.some(entry => entry.host === HOST && entry.slots === 1 && entry.browser === 1), resources.stdout);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'runner-local-holder', kind: 'force-registered-runner' });
    const successful = await runThroughGate(repo, env, 'node --test --test-reporter=tap runner-probe.test.js', { landing: true, requests });
  assert.equal(successful.status, 0, fixtureResultContext(successful));
  assert.match(successful.stdout, /TAP version 13/);
  assert.match(successful.stdout, /RUNNER_FACT /);
  const fact = JSON.parse(/RUNNER_FACT (\{[^\n]+\})/u.exec(successful.stdout)?.[1] ?? 'null');
  assert.equal(fact.commit, selectedCommit);
  assert.equal(fact.tree, selectedTree);
  assert.equal(fact.landing, '1', 'the remote landing command receives the trusted landing marker');
  assert.notEqual(fact.cwd, repo);
  const remotePath = relative(remoteStateRoot, fact.cwd);
  assert.ok(remotePath && !remotePath.startsWith('..' + sep) && remotePath !== '..');
  assert.ok(fact.home.startsWith(fact.cwd.slice(0, fact.cwd.indexOf('/checkout'))));
  assert.notEqual(fact.gatePool, 'caller-pool-marker');
  assert.notEqual(fact.gateToken, 'caller-token-marker');
  assert.equal(fact.browser, '1');
  const result = gateResult(successful.stdout);
  assert.equal(result.isGreen, true);
  assert.equal(result.runner, HOST);
  assert.equal(result.profile.executionRunner, HOST);
  assert.equal(result.profile.tests.length, 1, 'TAP results are retained in the ordinary profile');
  const source = result.profile.executionSource;
  assert.equal(source.commit, selectedCommit);
  assert.equal(source.tree, selectedTree);
  assert.equal(source.tooling.name, 'pullboard');
  assert.equal(source.tooling.kind, 'git-checkout');
  assert.match(source.tooling.sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(source.tooling.commit, selectedCommit, 'the tooling checkout has provenance separate from the tiny fixture project');
  const request = JSON.parse(readFileSync(requests, 'utf8').trim().split('\n')[0]);
  assert.equal(request.host, HOST);
  assert.equal(request.framed, true);
  assert.equal(request.remoteCommandPresent, true);
  for (const option of ['-T', 'BatchMode=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'SendEnv=-*',
    'ConnectTimeout=10', 'ServerAliveInterval=10', 'ServerAliveCountMax=3']) {
    assert.ok(request.options.includes(option), `SSH includes ${option}`);
  }
  assert.equal(request.remoteHasSecret, false);
  assert.equal(request.remoteHasLocalPath, false);
  assert.equal(request.remoteHasSourceHome, false);
  assert.equal(request.remoteHasSourceMachineHome, false);
  assert.ok(request.stdinBytes > 0, 'the exact commit objects arrived through binary stdin');
  assert.equal(request.secretInLocalSshEnv, false);
  assert.equal(request.localPoolMarkerInLocalSshEnv, false);
  assert.equal(request.localHeldMarkerInLocalSshEnv, false);
  assert.equal(request.localTokenMarkerInLocalSshEnv, false);
  assert.equal(request.localMachineHomeInSshEnv, false);
  assert.doesNotMatch(successful.stdout + successful.stderr, new RegExp(SECRET, 'u'));

  const red = await runThroughGate(repo, env, "node -e 'if (process.env.PULLBOARD_LANDING_RUN !== \"0\") process.exit(9); process.stdout.write(\"RUNNER_EXIT_7\\n\"); process.exit(7)'", { requests });
  assert.equal(red.status, 1, fixtureResultContext(red));
  assert.match(red.stdout, /RUNNER_EXIT_7/);
  const redResult = gateResult(red.stdout);
  assert.equal(redResult.isGreen, false);
  assert.equal(redResult.runner, HOST);
  const callsAfterExit7 = readFileSync(requests, 'utf8').trim().split('\n').length;
  assert.equal(callsAfterExit7, 2, 'a complete exit-7 receipt is a test failure, not a dropped-run retry');

  // A real full-suite runner produced more than ten thousand small process journals.
  // Exercise that boundary in the worker without launching thousands of fixture processes.
  writeFileSync(join(repo, 'runner-many-journals.js'), `import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const option = /(?:^|\\s)--import=(?:"([^"]+)"|'([^']+)'|(\\S+))/u.exec(process.env.NODE_OPTIONS || '');
if (!option) throw new Error('runner preload path was not passed to the committed job');
const journal = join(dirname(fileURLToPath(option[1] || option[2] || option[3])), 'child-journal');
for (let index = 0; index < 10_001; index++) {
  const pid = 2_000_000 + index;
  writeFileSync(join(journal, 'children-' + pid + '.jsonl'), JSON.stringify({
    type: 'boot', pid, ppid: process.pid, instance: 'bounded-journal-fixture-' + index,
  }) + '\\n');
}
console.log('RUNNER_JOURNAL_FILES ' + readdirSync(journal).filter(name => /^children-\\d+\\.jsonl$/u.test(name)).length);
`);
  git(repo, env, 'add', 'runner-many-journals.js');
  git(repo, env, 'commit', '-q', '-m', 'test: cover a bounded large runner journal');
  const manyJournals = await runThroughGate(repo, env, 'node runner-many-journals.js', { requests });
  assert.equal(manyJournals.status, 0, fixtureResultContext(manyJournals));
  const journalCount = Number(/RUNNER_JOURNAL_FILES (\d+)/u.exec(manyJournals.stdout)?.[1]);
  assert.ok(journalCount > 10_000, 'the real worker saw more journal files than the old limit');
  const manyResult = gateResult(manyJournals.stdout);
  assert.equal(manyResult.isGreen, true, 'the bounded journal returns a complete successful receipt');
  assert.equal(manyResult.runner, HOST);
  assert.equal(readRemoteGateHolders(join(remoteMachineHome, 'resources.sqlite')).length, 0,
    'the physical runner lease is released after successful cleanup');
  const callsAfterManyJournals = readFileSync(requests, 'utf8').trim().split('\n').length;
  assert.equal(callsAfterManyJournals, 3, 'the large-journal command ran remotely exactly once');

  const tagSecretAssignment = `${['RUNNER', 'FIXTURE', 'SECRET'].join('_')}=${SECRET}`;
  git(repo, env, 'tag', '-a', 'runner-private-tag', '-m', tagSecretAssignment, 'HEAD');
  const privateTag = await runThroughGate(repo, env, 'node -e "process.stdout.write(\'PRIVATE_TAG_SCAN_REACHED\\n\')"', { requests });
  assert.equal(privateTag.status, 1, fixtureResultContext(privateTag));
  assert.match(privateTag.stdout + privateTag.stderr, /RUNNER_SECRET/u);
  assert.doesNotMatch(privateTag.stdout + privateTag.stderr, new RegExp(SECRET, 'u'));
  assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, callsAfterManyJournals,
    'a secret annotated tag is refused before opening an SSH request');
  git(repo, env, 'tag', '-d', 'runner-private-tag');

  // The secret is absent from HEAD but remains in a reachable commit; full-history scanning must
  // refuse before transferring those historical objects to the registered worker.
  git(repo, env, 'add', '-f', '.env');
  git(repo, env, 'commit', '-q', '-m', 'test: add temporary historical private file');
  git(repo, env, 'rm', '--cached', '.env');
  git(repo, env, 'commit', '-q', '-m', 'test: remove current private file but retain history');
  assert.doesNotMatch(git(repo, env, 'ls-tree', '-r', '--name-only', 'HEAD'), /(?:^|\n)\.env(?:$|\n)/u);
  assert.equal(readFileSync(join(repo, '.env'), 'utf8'), SECRET, 'the ignored local fixture remains private');
  const historicalRed = await runThroughGate(repo, env, 'node -e "process.stdout.write(\'HISTORICAL_SECRET_SCAN_REACHED\\n\')"', { requests });
  assert.equal(historicalRed.status, 1, fixtureResultContext(historicalRed));
  assert.match(historicalRed.stdout + historicalRed.stderr, /RUNNER_SECRET/u);
  assert.doesNotMatch(historicalRed.stdout + historicalRed.stderr, new RegExp(SECRET, 'u'));
  assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, callsAfterManyJournals,
    'historical secret scanning refuses before opening an SSH request');

  assert.equal(commit.length, 40);
  assert.equal(tree.length, 40);
  } finally {
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

/** List live processes whose command line mentions a fixture directory. */
function processesUnder(dir) {
  const listed = runFixtureChild('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(listed.status, 0, listed.context);
  return listed.stdout.split('\n').filter(line => line.includes(dir) && !line.includes('/bin/ps'));
}

test('a queued runner run finishes or fails by name within its deadline [C7]', { timeout: 120_000 }, async (t) => { // budget: one real round trip plus three held phases, each stopped by its own deadline.
  // Linux lists kernel threads with process group 0. A census holding them must still parse, or
  // runner cleanup can never be verified on a real Linux host and every round trip waits forever.
  const linuxCensus = [
    '    1     0     1 Fri Oct 16 19:03:32 2026 Ss   systemd',
    '    2     0     0 Fri Oct 16 19:03:32 2026 S    kthreadd',
    '    3     2     0 Fri Oct 16 19:03:32 2026 I<   kworker/R-rcu_g',
    '  812     1   812 Fri Oct 16 19:05:01 2026 Ss   node',
  ].join('\n');
  const parsed = parseProcessCensus(linuxCensus);
  assert.ok(parsed, 'a census with kernel threads in process group 0 still parses');
  assert.deepEqual([...parsed.keys()], [1, 812], 'kernel threads are skipped; real processes are kept');
  assert.equal(parseProcessCensus('    5     1     5 Fri Oct 16 19:03:32 2026 S    node\nnot a census row'), null, 'a malformed row still voids the census');

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-deadline-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare runner deadline fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  const command = `node -e ${shellQuote('process.stdout.write("ROUND_TRIP_DONE\\n")')}`;

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    // Fill the controller's own gate so every run below goes to the runner.
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'local-holder', kind: 'force-registered-runner' });

    // The real round trip still passes inside its deadlines.
    const real = await runThroughGate(repo, env, command, { item: 'deadline-real', requests });
    assert.equal(real.status, 0, fixtureResultContext(real));
    assert.match(real.stdout, /ROUND_TRIP_DONE/u);
    assert.equal(gateResult(real.stdout).runner, HOST);
    assert.deepEqual(phaseCounts(`${requests}.phases`), { dispatched: 1, returned: 1 });

    /** Hold the fake runner at one phase and expect the round trip to fail naming it, in time. */
    const heldAt = async (hold, phase, deadlines, ceiling) => {
      installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, hold });
      const started = Date.now();
      await assert.rejects(runThroughGate(repo, env, command, { item: `deadline-${hold}`, requests, deadlines }),
        new RegExp(`runner round trip stuck in phase "${phase}"`, 'u'), `a runner held at ${hold} fails naming the ${phase} phase`);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < ceiling, `the ${phase} failure arrives in ${elapsed} ms, under ${ceiling} ms`);
      assert.deepEqual(processesUnder(dir), [], `nothing from the held ${phase} round trip keeps running`);
    };
    // With the default deadlines a runner that never answers fails by name within about a minute.
    await heldAt('run', 'remote run', undefined, 60_000);
    await heldAt('dispatch', 'dispatch', { dispatch: 3_000 }, 15_000);
    await heldAt('return', 'result return', { 'result return': 3_000 }, 15_000);
  } finally {
    held?.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (dropped runner returns ticket before later work)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-retry-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const queueReady = join(dir, 'both-waiters-queued');
  const firstStarted = join(dir, 'first-started');
  const releaseFirst = join(dir, 'release-first');
  const olderStarted = join(dir, 'older-local-started');
  const olderQueued = join(dir, 'older-local-queued');
  const order = join(dir, 'execution-order');
  for (const folder of [repo, worker, bin, home, remoteHome, remoteMachineHome, machineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PULLBOARD_RUNNER_FIXTURE_SECRET: SECRET, SSH_AUTH_SOCK: join(dir, 'must-not-forward.sock'),
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare dropped-runner fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, dropFirst: true });
  const host = `${HOST}-drop`;
  const added = cli(repo, env, 'runner', 'add', host, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  let first;
  let second;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'local-holder', kind: 'controlled-hold' });
    const olderCode = `require('node:fs').appendFileSync(${JSON.stringify(order)}, 'older-local\\n'); require('node:fs').writeFileSync(${JSON.stringify(olderStarted)}, 'started\\n');`;
    const firstCode = `const fs=require('node:fs'); const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{ fs.writeFileSync(${JSON.stringify(firstStarted)}, 'started\\n'); fs.appendFileSync(${JSON.stringify(order)}, 'retry-first\\n');
while(!fs.existsSync(${JSON.stringify(releaseFirst)})) await sleep(5); })().catch(error=>{console.error(error);process.exitCode=2});`;
    second = observe(startQueueController(repo, env, `node -e ${shellQuote(olderCode)}`,
      { item: 'older-local', queueMarker: olderQueued, firstItem: null, remote: false }));
    await waitForMarker(olderQueued);
    first = observe(startQueueController(repo, env, `node -e ${shellQuote(firstCode)}`,
      { item: 'retry-first', queueMarker: queueReady, firstItem: 'older-local' }));
    // The SSH stand-in creates this file only after appending its first request record.
    await waitForMarker(requests);
    const dropped = JSON.parse(readFileSync(requests, 'utf8').trim().split('\n')[0]);
    assert.equal(dropped.dropped, true, 'the first SSH connection drops without a completion receipt');
    await waitForMarker(queueReady);
    held.release();
    held = null;
    await waitForMarker(firstStarted);
    assert.equal(readFileSync(order, 'utf8'), 'retry-first\n', 'the returned remote ticket jumps ahead of the older local-only waiter');
    writeFileSync(releaseFirst, 'continue\n');
    const [firstResult, secondResult] = await Promise.all([first.closed, second.closed]);
    assert.equal(firstResult.status, 0, `${firstResult.stdout}${firstResult.stderr}`);
    assert.equal(secondResult.status, 0, `${secondResult.stdout}${secondResult.stderr}`);
    assert.equal(readFileSync(order, 'utf8'), 'retry-first\nolder-local\n');
    assert.ok(existsSync(olderStarted), 'the older local-only waiter runs after the returned remote ticket');
    assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1,
      'the quarantined host is not contacted again for the front-of-queue local retry');
    const retried = gateResult(firstResult.stdout);
    assert.equal(retried.isGreen, true, `${firstResult.stdout}${firstResult.stderr}`);
    assert.notEqual(retried.runner, host, 'the retried command completes after the failed runner is quarantined');
  } finally {
    if (held) held.release();
    writeFileSync(releaseFirst, 'cleanup-release\n');
    for (const child of [first?.child, second?.child]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all([first?.closed, second?.closed].filter(Boolean));
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (disconnect drains an npm setup child before releasing its gate holder)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-setup-disconnect-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const packageDirectory = join(repo, 'packages', 'setup-fixture-dep');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const setupReady = join(dir, 'setup-ready');
  const setupPid = join(dir, 'setup-pid');
  const setupTerm = join(dir, 'setup-term');
  const releaseSetup = join(dir, 'release-setup');
  const setupGone = join(dir, 'setup-gone');
  const remoteDatabase = join(remoteMachineHome, 'resources.sqlite');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome, packageDirectory]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Setup Fixture', GIT_AUTHOR_EMAIL: 'runner-setup@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Setup Fixture', GIT_COMMITTER_EMAIL: 'runner-setup@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'runner-setup-fixture', version: '1.0.0', private: true, type: 'module',
    workspaces: ['packages/setup-fixture-dep'], dependencies: { 'setup-fixture-dep': '1.0.0' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'setup-fixture-dep', version: '1.0.0', scripts: { postinstall: 'node postinstall.js' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'witness.txt'), 'setup fixture package source\n');
  writeFileSync(join(packageDirectory, 'postinstall.js'), `import { existsSync, writeFileSync } from 'node:fs';
const ready = ${JSON.stringify(setupReady)};
const pidFile = ${JSON.stringify(setupPid)};
const term = ${JSON.stringify(setupTerm)};
const release = ${JSON.stringify(releaseSetup)};
const gone = ${JSON.stringify(setupGone)};
const waitForRelease = new Promise((resolve, reject) => {
  if (existsSync(release)) return resolve();
  let poll, timer;
  let settled = false;
  const finish = error => {
    if (settled) return;
    settled = true;
    clearInterval(poll); clearTimeout(timer); error ? reject(error) : resolve();
  };
  const check = () => { if (existsSync(release)) finish(); };
  poll = setInterval(check, 20); // budget: observe the actual release handshake.
  timer = setTimeout(() => finish(new Error('postinstall release hang ceiling exceeded')), 20_000); // budget: unchanged broken-fixture ceiling.
  check();
});
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  writeFileSync(term, 'term received\\n');
  waitForRelease.then(() => { writeFileSync(gone, 'setup child exited\\n'); process.exit(0); }, error => {
    console.error(error.message); process.exit(2);
  });
});
writeFileSync(pidFile, String(process.pid) + '\\n');
writeFileSync(ready, 'setup started\\n');
`);
  const npmPathResult = runFixtureChild('which', ['npm'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(npmPathResult.status, 0, npmPathResult.context);
  const packageLock = runFixtureChild(npmPathResult.stdout.trim(), ['install', '--package-lock-only', '--ignore-scripts', '--offline'], {
    cwd: repo, env, encoding: 'utf8',
  });
  assert.equal(packageLock.status, 0, packageLock.context);
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'package.json', 'package-lock.json', 'packages/setup-fixture-dep');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare disconnect during runner setup');

  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, dropAfterMarker: setupReady });
  const host = `${HOST}-setup`;
  const added = cli(repo, env, 'runner', 'add', host, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  let run;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'setup-local-holder', kind: 'force-registered-runner' });
    const code = `process.stdout.write('SETUP_RETRY_LOCAL\\n')`;
    run = observe(startQueueController(repo, env, `node -e ${shellQuote(code)}`,
      { item: 'setup-disconnect', firstItem: null }));

    await waitForMarker(setupReady);
    const childPid = Number(readFileSync(setupPid, 'utf8').trim());
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    await waitForMarker(setupTerm);
    const liveHolders = readRemoteGateHolders(remoteDatabase);
    assert.equal(liveHolders.length, 1, 'the remote gate holder remains while its setup child is handling termination');
    assert.ok(liveHolders[0].agent.startsWith('pullboard-ssh-'));
    assert.equal(liveHolders[0].item, 'setup-disconnect');
    assert.equal(liveHolders[0].kind, 'runner-retry-test');
    assert.equal(liveHolders[0].browser, 1);
    assert.notEqual(liveHolders[0].pid, childPid, 'the holder belongs to the worker, not its npm setup child');
    assert.equal(existsSync(setupGone), false, 'the setup child has not exited before its release handshake');

    held.release();
    held = null;
    writeFileSync(releaseSetup, 'release setup child\\n');
    await waitForMarker(setupGone);
    const result = await run.closed;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /SETUP_RETRY_LOCAL/u, 'the transport drop requeues the run onto the local slot');
    assert.equal(gateResult(result.stdout).isGreen, true);
    assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1);
    const request = JSON.parse(readFileSync(requests, 'utf8').trim().split('\n')[0]);
    assert.equal(request.droppedAfterSetup, true, 'the stand-in drops the connection after npm setup actually starts');
    assert.equal(request.workerStarted, true);
    assert.notEqual(request.code, 0, 'the worker exits without a complete success receipt after HUP');
    // Observe release through the actual pool, including its normal dead-worker lease reaping.
    await waitForCondition(() => {
      const previous = process.env.PULLBOARD_MACHINE_HOME;
      process.env.PULLBOARD_MACHINE_HOME = remoteMachineHome;
      try {
        return listResources({ scope: 'machine', root: worker })
          .some(resource => resource.name === 'gate' && resource.holders.length === 0);
      } finally {
        if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
        else process.env.PULLBOARD_MACHINE_HOME = previous;
      }
    }, 'the remote pool releases its setup holder after the owned child exits');
    assert.equal(readRemoteGateHolders(remoteDatabase).length, 0, 'the remote holder is released after the owned setup child exits');
  } finally {
    if (held) held.release();
    writeFileSync(releaseSetup, 'cleanup release\\n');
    if (run?.child && run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
    await run?.closed;
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (cached source and npm content retain fresh checkout lifecycles)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-cache-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteStateRoot = join(remoteHome, 'private-runner-root');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const installWitnesses = join(dir, 'remote-install-witnesses');
  const packageDirectory = join(repo, 'packages', 'runner-fixture-dep');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteStateRoot, remoteMachineHome, packageDirectory]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Cache Fixture', GIT_AUTHOR_EMAIL: 'runner-cache@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Cache Fixture', GIT_COMMITTER_EMAIL: 'runner-cache@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ngenerated/\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'runner-cache-fixture', version: '1.0.0', private: true, type: 'module',
    scripts: { prepare: 'node prepare.js' },
    workspaces: ['packages/runner-fixture-dep'], dependencies: { 'runner-fixture-dep': '1.0.0' },
  }, null, 2) + '\n');
  writeFileSync(join(repo, 'prepare.js'), `import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('generated', { recursive: true });
writeFileSync('generated/config.json', JSON.stringify({ root: resolve('.') }) + '\\n');
`);
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'runner-fixture-dep', version: '1.0.0', type: 'module', scripts: { postinstall: 'node postinstall.js' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'witness.txt'), 'committed workspace witness\n');
  writeFileSync(join(repo, 'history-original.txt'), 'committed cache history witness\n');
  writeFileSync(join(packageDirectory, 'postinstall.js'), `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const prefix = process.env.INIT_CWD;
if (!prefix) throw new Error('npm did not provide the install root');
writeFileSync(join(prefix, 'node_modules', '.runner-cache-witness'), readFileSync(new URL('./witness.txt', import.meta.url)));
appendFileSync(${JSON.stringify(installWitnesses)}, 'postinstall\\n');
`);
  const npmPathResult = runFixtureChild('which', ['npm'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(npmPathResult.status, 0, npmPathResult.context);
  const npmPath = npmPathResult.stdout.trim();
  const lock = runFixtureChild(npmPath, ['install', '--package-lock-only', '--ignore-scripts', '--offline'], {
    cwd: repo, env, encoding: 'utf8',
  });
  assert.equal(lock.status, 0, lock.context);
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'package.json', 'prepare.js', 'package-lock.json', 'packages/runner-fixture-dep', 'history-original.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare cached local workspace dependency');
  const historyBaseCommit = git(repo, env, 'rev-parse', 'HEAD');
  git(repo, env, 'mv', 'history-original.txt', 'history-renamed.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: preserve cached runner history witness');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, nodeCommand: process.execPath });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--node', process.execPath,
    '--root', remoteStateRoot, '--json');
  assert.equal(added.status, 0, added.context);
  const registered = JSON.parse(added.stdout);
  assert.equal(registered.runner.node, process.execPath);
  assert.equal(registered.runner.root, remoteStateRoot);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-cache-local-holder', item: 'cache-local-holder', kind: 'force-registered-runner' });
    const command = 'node --test --test-reporter=tap runner-cache-probe.test.js';
    writeCacheProbe(repo, { remoteStateRoot, nodePath: process.execPath, historyBaseCommit });
    git(repo, env, 'add', 'runner-cache-probe.test.js');
    git(repo, env, 'commit', '-q', '-m', 'test: assert cache symlink stays job-local');
    const cacheCommit = git(repo, env, 'rev-parse', 'HEAD');
    const cacheTree = git(repo, env, 'rev-parse', 'HEAD^{tree}');
    const first = await runThroughGate(repo, env, command, { item: 'cache-first', requests });
    assert.equal(first.status, 0, fixtureResultContext(first));
    const firstFact = JSON.parse(/RUNNER_CACHE_FACT (\{[^\n]+\})/u.exec(first.stdout)?.[1] ?? 'null');
    assert.equal(firstFact.commit, cacheCommit);
    assert.equal(firstFact.tree, cacheTree);
    assert.equal(firstFact.shallow, 'false');
    assert.ok(firstFact.history.includes(historyBaseCommit));
    assert.equal(firstFact.root, firstFact.target.slice(0, firstFact.target.indexOf('/packages/runner-fixture-dep')));
    assert.equal(gateResult(first.stdout).runner, HOST);
    assert.equal(firstFact.generatedRoot, firstFact.root, 'the first fresh checkout ran root prepare');
    assert.equal(readFileSync(installWitnesses, 'utf8'), 'postinstall\n', 'the first fresh checkout runs the committed workspace postinstall');

    const second = await runThroughGate(repo, env, command, { item: 'cache-second', requests });
    assert.equal(second.status, 0, fixtureResultContext(second));
    const secondFact = JSON.parse(/RUNNER_CACHE_FACT (\{[^\n]+\})/u.exec(second.stdout)?.[1] ?? 'null');
    assert.equal(secondFact.commit, cacheCommit);
    assert.equal(secondFact.tree, cacheTree);
    assert.equal(secondFact.shallow, 'false');
    assert.ok(secondFact.history.includes(historyBaseCommit));
    assert.equal(secondFact.generatedRoot, secondFact.root, 'the second fresh checkout reran root prepare');
    assert.equal(gateResult(second.stdout).runner, HOST);
    assert.equal(secondFact.root, secondFact.target.slice(0, secondFact.target.indexOf('/packages/runner-fixture-dep')));
    assert.notEqual(firstFact.root, secondFact.root, 'each run unpacks a fresh checkout');
    assert.equal(git(repo, env, 'rev-parse', 'HEAD'), cacheCommit);
    assert.equal(git(repo, env, 'rev-parse', 'HEAD^{tree}'), cacheTree);
    assert.equal(readFileSync(installWitnesses, 'utf8'), 'postinstall\npostinstall\n', 'the second fresh checkout runs its own workspace postinstall');
    const requestsSeen = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requestsSeen.length, 2);
    assert.ok(requestsSeen[0].stdinBytes > requestsSeen[1].stdinBytes,
      'the same candidate sends fewer Git-pack bytes after its first cache import');
    assert.ok(requestsSeen.every(request => request.remoteStartsWithConfiguredNode), 'both remote workers use the configured absolute Node path');
  } finally {
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (older resource clients keep local capacity separate)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-old-resource-client-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const remoteReady = join(dir, 'remote-ready');
  const releaseRemote = join(dir, 'release-remote');
  const secondBrowserQueued = join(dir, 'second-browser-queued');
  const secondBrowserAcquired = join(dir, 'second-browser-acquired');
  const resourceDatabase = join(machineHome, 'resources.sqlite');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 2 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Legacy Resource Fixture', GIT_AUTHOR_EMAIL: 'legacy-resource@example.invalid',
    GIT_COMMITTER_NAME: 'Legacy Resource Fixture', GIT_COMMITTER_EMAIL: 'legacy-resource@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'registered runner fixture\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare mixed-version resource fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let initialBrowser;
  let localBrowser;
  let localCpu;
  let secondBrowser;
  let secondBrowserPromise;
  let remoteRun;
  const inspectCapacity = expectedLocal => {
    const db = new DatabaseSync(resourceDatabase, { readOnly: true });
    try {
      const local = db.prepare("SELECT name, runner, browser FROM holder WHERE name = 'gate'").all();
      const remote = db.prepare('SELECT name, runner, browser FROM holder WHERE runner = ?').all(HOST);
      assert.equal(db.prepare("SELECT capacity FROM resource WHERE name = 'gate'").get()?.capacity, 2);
      assert.equal(db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity, 1);
      const browserCount = local.filter(holder => holder.browser === 1).length;
      assert.ok(local.length <= 2, 'local gate holders stay within the real SQLite gate capacity');
      assert.ok(browserCount <= 1, 'local browser holders stay within the real SQLite browser capacity');
      assert.equal(local.length, expectedLocal);
      assert.equal(remote.length, 1, 'the remote runner holder remains independent of local capacity');
      assert.equal(remote[0].name, `runner:${HOST}`);
      return { local, remote, browserCount };
    } finally { db.close(); }
  };
  try {
    initialBrowser = await takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-initial-browser', item: 'pre-runner-initial-browser', kind: 'fixture-hold', browser: true });
    const remoteCode = `const fs=require('node:fs'); const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{ fs.writeFileSync(${JSON.stringify(remoteReady)}, 'ready\\n'); while(!fs.existsSync(${JSON.stringify(releaseRemote)})) await sleep(5); })().catch(error=>{console.error(error);process.exitCode=2});`;
    remoteRun = observe(startQueueController(repo, env, `node -e ${shellQuote(remoteCode)}`,
      { item: 'remote-capacity-holder', queueMarker: null, firstItem: null }));
    await waitForMarker(remoteReady);

    const heldBesideRemote = inspectCapacity(1);
    assert.equal(heldBesideRemote.browserCount, 1, 'the remote lease leaves the legacy local browser holder unchanged');

    initialBrowser.release();
    initialBrowser = null;
    localBrowser = await takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-browser-one', item: 'pre-runner-browser-one', kind: 'fixture-browser', browser: true });
    localCpu = await takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-cpu', item: 'pre-runner-cpu', kind: 'fixture-cpu' });
    secondBrowserPromise = takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-browser-two', item: 'pre-runner-browser-two', kind: 'fixture-browser', browser: true,
      onWait(state) {
        if (state.line?.some(waiter => waiter.item === 'pre-runner-browser-two')) {
          writeFileSync(secondBrowserQueued, 'queued\n');
        }
      },
    }).then(lease => {
      secondBrowser = lease;
      writeFileSync(secondBrowserAcquired, 'acquired\n');
      return lease;
    });
    await waitForMarker(secondBrowserQueued);
    assert.equal(existsSync(secondBrowserAcquired), false, 'a second local browser waits even while its first slot is held');

    const duringRemote = listPreRunnerResources({ scope: 'machine', root: repo });
    const localGate = duringRemote.find(resource => resource.name === 'gate');
    const runnerResource = duringRemote.find(resource => resource.name === `runner:${HOST}`);
    assert.equal(localGate.holders.length, 2, 'the old API admits one local browser and one local CPU lease');
    assert.equal(localGate.holders.filter(holder => holder.browser).length, 1);
    assert.equal(runnerResource.holders.length, 1, 'the registered runner remains held independently');
    assert.equal(inspectCapacity(2).browserCount, 1);
    assert.equal(existsSync(secondBrowserAcquired), false, 'local browser capacity remains one');

    localCpu.release();
    localCpu = null;
    localBrowser.release();
    localBrowser = null;
    await waitForMarker(secondBrowserAcquired);
    secondBrowser = await secondBrowserPromise;
    const afterHandoff = listPreRunnerResources({ scope: 'machine', root: repo });
    assert.equal(afterHandoff.find(resource => resource.name === 'gate').holders.length, 1);
    assert.equal(afterHandoff.find(resource => resource.name === `runner:${HOST}`).holders.length, 1,
      'the remote run is still live while the old API hands off the local browser slot');
    assert.equal(inspectCapacity(1).browserCount, 1);
    secondBrowser.release();
    secondBrowser = null;
    writeFileSync(releaseRemote, 'release\n');
    const completed = await remoteRun.closed;
    remoteRun = null;
    assert.equal(completed.status, 0, fixtureResultContext(completed));
    assert.equal(gateResult(completed.stdout).runner, HOST);
  } finally {
    for (const lease of [initialBrowser, localBrowser, localCpu, secondBrowser]) lease?.release();
    writeFileSync(releaseRemote, 'cleanup-release\n');
    if (secondBrowserPromise && !secondBrowser) {
      try { secondBrowser = await secondBrowserPromise; secondBrowser.release(); secondBrowser = null; } catch {}
    }
    if (remoteRun) {
      await remoteRun.closed;
    }
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

/** Run one action with the process's machine home pointed at another fixture machine. */
function onMachine(machineHome, action) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

test('a refused remote setup fails the run by name [C7]', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-refused-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const remoteStderr = join(dir, 'remote-stderr.log');
  const ran = join(dir, 'command-ran');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare refused runner setup fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, stderrLog: remoteStderr });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  // The runner's own pool is busy at more slots than its registration, so the worker's request is refused.
  let remoteHolder = await onMachine(remoteMachineHome, () => takeResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
    agent: 'fixture-remote-holder', item: 'remote-holder', kind: 'force-busy-runner' }));

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  let run;
  try {
    // Fill the controller's own gate so the run goes to the runner.
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'local-holder', kind: 'force-registered-runner' });
    const startedAt = Date.now();
    run = observe(startQueueController(repo, env, `node -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran')`)}`,
      { item: 'refused-setup', queueMarker: null, firstItem: null }));
    const deadline = new Promise(resolve => { const timer = setTimeout(() => resolve(null), 30_000); timer.unref(); }); // budget: the bar's 30-second ceiling.
    const result = await Promise.race([run.closed, deadline]);
    assert.ok(result, 'the controller ends the refused run within 30 seconds');
    assert.ok(Date.now() - startedAt < 30_000); // budget: declared 30-second completion ceiling in the frozen #690 criterion.
    assert.notEqual(result.status, 0, 'a refused remote setup is a failed run');
    const said = `${result.stdout}${result.stderr}`;
    // Since #1066 the registration sizes the runner's pool, and a busy pool cannot shrink to it.
    assert.match(result.stderr, new RegExp(`\\[RUNNER_SETUP_REFUSED\\] runner ${HOST} refused this run before it started: \\[RUNNER_CAPACITY_BUSY\\]`, 'u'),
      `the failure names the runner host and the refusal code\n${said}`);
    assert.equal(result.stdout.includes('PULLBOARD_RUN_RESULT'), false, 'the refused run reports no test result');
    assert.equal(existsSync(ran), false, 'the command never ran');

    const receipts = readFileSync(remoteStderr, 'utf8').split('\n').filter(line => line.startsWith('PULLBOARD_RUNNER_RESULT '));
    assert.equal(receipts.length, 1, 'the worker writes one result receipt');
    const ended = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(ended.length, 1, 'the refused run is not retried on the runner');
    assert.equal(ended[0].workerStarted, true);
    assert.equal(ended[0].code, 0, 'the worker exits after its receipt');

    remoteHolder.release();
    remoteHolder = null;
    const remote = onMachine(remoteMachineHome, () => listResources({ scope: 'machine', root: repo }));
    for (const resource of remote) {
      assert.deepEqual([resource.holders.length, resource.line.length], [0, 0], `runner pool ${resource.name} keeps no holder or waiter`);
    }
    const local = onMachine(machineHome, () => listResources({ scope: 'machine', root: repo }));
    assert.deepEqual(local.find(resource => resource.name === `runner:${HOST}`)?.holders ?? [], [], 'the runner slot is released');
    assert.deepEqual(local.find(resource => resource.name === 'gate').line, [], 'the run is not left waiting in the controller queue');
  } finally {
    held?.release();
    remoteHolder?.release();
    if (run) {
      const ceiling = new Promise(resolve => { const timer = setTimeout(resolve, 20_000); timer.unref(); }); // budget: a hung controller must not hold the test file open.
      if (!(await Promise.race([run.closed.then(() => true), ceiling]))) run.child.kill('SIGTERM');
      await run.closed;
    }
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a remote file denial is classified on the runner [I1,C7]', { skip: process.getuid?.() === 0 && 'root reads any file' }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-denial-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [home, remoteHome, repo, worker, bin] = ['home', 'worker-home', 'repo', 'second-machine', 'bin'].map(name => join(dir, name));
  const machineHome = join(home, '.pullboard');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const requests = join(dir, 'ssh-requests.jsonl');
  const realpaths = join(dir, 'controller-realpaths.log');
  const preload = join(dir, 'realpath-witness.mjs');
  for (const folder of [repo, worker, bin, machineHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  // The controller logs every path it realpaths that lies on the runner, so resolving one is caught.
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const real = fs.realpathSync; const native = real.native;
const log = path => { if (String(path).includes(${JSON.stringify(remoteHome)})) fs.appendFileSync(${JSON.stringify(realpaths)}, String(path) + '\\n'); };
fs.realpathSync = Object.assign((path, ...rest) => { log(path); return real(path, ...rest); }, { native: (path, ...rest) => { log(path); return native(path, ...rest); } });
syncBuiltinESMExports();\n`);
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  git(repo, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  git(repo, env, 'add', 'pullboard.json');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare remote denial fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  const controllerEnv = { ...env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() };
  // The unreadable file sits beside the runner's checkout, outside its worktree, on the runner only.
  const denied = "mkdir ../denied && echo kept > ../denied/secret && chmod 000 ../denied/secret && node -e \"require('node:fs').readFileSync('../denied/secret')\"";
  const ordinary = "node -e \"require('node:assert').strictEqual('open ../denied/secret (EACCES)', 'an ordinary assertion')\"";
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    // Fill the controller's own gate so each run goes to the runner.
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'local-holder', kind: 'force-registered-runner' });
    const blocked = await runThroughGate(repo, controllerEnv, denied, { item: '706', requests });
    const blockedResult = gateResult(blocked.stdout);
    assert.equal(blockedResult.runner, HOST, fixtureResultContext(blocked));
    assert.equal(blockedResult.isGreen, false);
    assert.match(blocked.stdout, /EACCES: permission denied, open '\.\.\/denied\/secret'/u, 'the raw denial still comes back unchanged');
    assert.equal(blockedResult.sandboxBlocked, `open outside its worktree (EACCES) on runner ${HOST}`,
      `the controller names the operation and the runner host from the runner's evidence\n${fixtureResultContext(blocked)}`);
    assert.throws(() => refuseSandboxBlocked(blockedResult), error => error.code === 'SANDBOX_BLOCKED'
      && error.message.includes(`refused open outside its worktree (EACCES) on runner ${HOST}`), 'a remote denial asks the person');
    const failed = await runThroughGate(repo, controllerEnv, ordinary, { item: '706', requests });
    const failedResult = gateResult(failed.stdout);
    assert.equal(failedResult.runner, HOST, fixtureResultContext(failed));
    assert.equal(failedResult.isGreen, false);
    assert.match(failed.stdout, /AssertionError/u);
    assert.equal(failedResult.sandboxBlocked, null, 'an ordinary remote assertion failure stays ordinary');
    assert.doesNotThrow(() => refuseSandboxBlocked(failedResult));
    assert.equal(existsSync(realpaths) ? readFileSync(realpaths, 'utf8') : '', '', 'the controller never realpaths a runner path');
  } finally {
    held?.release();
    for (const [key, value] of [['PULLBOARD_HOME', previous[0]], ['PULLBOARD_MACHINE_HOME', previous[1]]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a machine with runners can run no tests itself [C7]', { timeout: 90_000 }, // budget: covers fixture setup plus three real runner transports and cleanup; not an execution-time target.
  () => runnerFirstPolicyCase(e2e));

const parentDeathTools = { cli, git, installSshStandIn, observe, startQueueController, waitForMarker, processIsAlive, shellQuote, HOST };
test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains a detached worker descendant before releasing its lease)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools)); // budget: fixture ceiling covers declared30-second remote cleanup plus startup, transport and final cleanup.

test('parent death retries a failed remote holder deletion after the real database writer releases [C7]',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { holdRelease: true })); // budget: same fixture deadline includes the real10-second SQLite busy attempt and release retry.

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains its worker while the command keeps writing output)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { chatty: true })); // budget: same fixture ceiling as the ordinary parent-death case.

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains its worker when a group signal answers EPERM)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { epermOnce: true })); // budget: same fixture ceiling as the ordinary parent-death case.

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains a child that leaves its group after the first census)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { lateGroup: true })); // budget: same fixture ceiling as the ordinary parent-death case.

const orphanTools = { cli, git, installSshStandIn, observe, startToolingCli, processIsAlive, HOST };
test('a runner job leaves no process behind, detached ones included [C7]',
  { timeout: 150_000 }, t => runnerOrphanFixture(t, orphanTools)); // budget: one plain runner round trip, then the declared 30-second remote cleanup timeout and a local rerun.
test('a runner job leaves no process behind, and never signals a process it cannot prove is the job\'s [C7]',
  { timeout: 30_000 }, t => unprovenProcessFixture(t, { createDescendantTracker, parseProcessCensus })); // budget: scripted census, no real processes.

test('machines report busy share and a new run goes to the idle one [C7,O5]', { timeout: 30_000 }, t => runnerStageFixture(t, e2e));

test('registered timing receipt names the physical worker and actual load [C7,Q1]', { timeout: 90_000 },
  t => runnerTimingReceipt(t, { cli, git, runThroughGate, gateResult }));

test('a runner uses the capacity it was registered with [C7,O5]', { timeout: 180_000 }, t => runnerUsesRegisteredCapacity(t, { cli, git, observe, startQueueController, gateResult })); // budget: two rounds of four concurrent runner round trips.

test('review655 a registered runner honors the same live person waiver at landing [B3,R3,C7]', { timeout: 120_000 }, async (t) => {
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const helper = createE2eHelpers();
  t.after(helper.cleanup);
  const box = helper.project('true');
  const repo = box.repo;
  const fixtureBin = join(box.dir, 'runner-bin');
  const remoteHome = join(box.dir, 'runner-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const worker = join(box.dir, 'second-machine');
  const requests = join(box.dir, 'runner-requests.jsonl');
  for (const folder of [fixtureBin, remoteHome, remoteMachineHome, worker, join(repo, 'bin'), join(repo, 'test')]) mkdirSync(folder, { recursive: true });
  const env = { ...box.env, PATH: fixtureBin + ':' + box.env.PATH };
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  cpSync(resolve(import.meta.dirname, '../src'), join(repo, 'src'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../bin'), join(repo, 'bin'), { recursive: true });
  const failing = 'test/review655-waived-red.test.js';
  writeFileSync(join(repo, failing), "import { test } from 'node:test'; test('review655 known waived runner flake', () => { throw new Error('known private flaky failure'); });\n");
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, gate: 'node bin/run-tests.js --test-concurrency=1 ' + failing }) + '\n');
  box.git(repo, 'add', 'package.json', 'pullboard.json', 'src', 'bin', failing);
  box.git(repo, 'commit', '-q', '-m', 'test: commit private registered-runner waiver fixture');
  const store = await import('../src/board.js');
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  let waiver;
  try { waiver = store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'review655-remote-person-waiver', test: failing, until: '2099-01-01', reason: 'same live person exception on either execution machine' }); }
  finally { store.closeBoard(board); }
  const capacity = cli(repo, env, 'settings', 'gateSlots', '1', '--json');
  assert.equal(capacity.status, 0, fixtureResultContext(capacity));
  const local = cli(repo, env, 'gate', '--landing', '--json');
  assert.equal(local.status, 0, fixtureResultContext(local));
  const localDocument = JSON.parse(local.stdout);
  assert.equal(localDocument.green, false);
  assert.equal(localDocument.waived[0].waiver, waiver.id, 'the same exact committed source is waived locally');
  installSshStandIn({ bin: fixtureBin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const registered = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(registered.status, 0, fixtureResultContext(registered));
  const priorHome = process.env.PULLBOARD_HOME, priorMachine = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo, agent: 'review655-local-holder', item: 'review655-local-holder', kind: 'force-registered-runner' });
    const phases = requests + '.phases';
    const before = phaseCounts(phases);
    const remote = observe(startToolingCli(repo, env, ['gate', '--landing', '--json'], { detached: true }));
    const result = await awaitRoundTrip(remote.child, remote.closed, phases, before);
    const profile = JSON.parse(readFileSync(join(repo, '.git', 'pullboard-gate.log.profile.json'), 'utf8'));
    const raw = readFileSync(join(repo, '.git', 'pullboard-gate.log'), 'utf8');
    assert.equal(profile.executionRunner, HOST, 'the real registered runner executed the frozen source');
    assert.equal(profile.executionSource?.commit, box.git(repo, 'rev-parse', 'HEAD'), 'local and remote execute the same committed failing test');
    assert.match(raw, /review655 known waived runner flake/u, 'the actual remote test is named in its result');
    assert.match(raw, /known private flaky failure/u, 'the actual committed test threw its known error');
    assert.match(raw, /^# tests 1$/mu, 'there is only this one committed test');
    const document = JSON.parse(result.stdout);
    console.log('review655 actual registered-runner waiver outcome ' + JSON.stringify({ localStatus: local.status, localWaiver: localDocument.waived[0].waiver, remoteStatus: result.status, executionRunner: profile.executionRunner, executionCommit: profile.executionSource?.commit, earlyStopped: raw.includes('Landing gate stopped early'), cancelled: /^# cancelled (\d+)$/mu.exec(raw)?.[1], raw, document }));
    assert.equal(result.status, 0, 'the same live person waiver must cover this named landing failure on the registered runner');
    assert.equal(document.green, false, 'a waived remote failure is never an ordinary green');
    assert.equal(document.waived[0].waiver, waiver.id);
    assert.equal(document.waived[0].file, failing, 'failure identities stay relative to the committed source');
    assert.equal(document.waived[0].reason, waiver.reason);
    assert.equal(document.waived[0].until, waiver.until);
    assert.equal(existsSync(join(repo, '.git', 'pullboard-gate-green')), false, 'a waived remote run writes no ordinary green stamp');
    assert.doesNotMatch(raw, /Landing gate stopped early/u);
    assert.match(raw, /^# cancelled 0$/mu);

    /** Change only the private gate, then require the real registered worker's complete response. */
    const remoteGate = async (command, message) => {
      writeFileSync(configPath, JSON.stringify({ ...config, gate: command }) + '\n');
      box.git(repo, 'add', 'pullboard.json');
      box.git(repo, 'commit', '-q', '-m', message);
      const prior = phaseCounts(phases);
      const run = observe(startToolingCli(repo, env, ['gate', '--landing', '--json'], { detached: true }));
      const finished = await awaitRoundTrip(run.child, run.closed, phases, prior);
      const measured = JSON.parse(readFileSync(join(repo, '.git', 'pullboard-gate.log.profile.json'), 'utf8'));
      assert.equal(measured.executionRunner, HOST, 'each accounting counter actually executes on the registered worker');
      assert.equal(measured.executionSource.commit, box.git(repo, 'rev-parse', 'HEAD'));
      assert.equal(existsSync(join(repo, '.git', 'pullboard-gate-green')), false);
      return { ...finished, document: JSON.parse(finished.stdout), raw: readFileSync(join(repo, '.git', 'pullboard-gate.log'), 'utf8') };
    };
    const tests = 'node bin/run-tests.js --test-concurrency=1 ' + failing;
    const throughCat = await remoteGate(tests + ' | cat', 'test: retain a remote TAP producer account');
    assert.equal(throughCat.status, 0, fixtureResultContext(throughCat));
    assert.equal(throughCat.document.green, false);
    assert.equal(throughCat.document.waived[0].waiver, waiver.id, 'the failing producer accounts for its own test');

    const independent = await remoteGate('node -e "process.exitCode=1" | ' + tests, 'test: retain an independent remote pipeline failure');
    assert.equal(independent.status, 1, 'an unattributed producer failure is not covered by the consumer test waiver');
    assert.match(independent.raw, /^# fail 1$/mu, 'the consumer still returns its complete waived TAP');
    assert.equal(independent.document.waived, undefined);

    const staged = await remoteGate(tests + '; node -e "process.exitCode=2"', 'test: retain a separate remote stage failure');
    assert.equal(staged.status, 1, 'a separate failing stage is not a test waiver');
    assert.equal(staged.document.waived, undefined);

  } finally {
    held?.release();
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome;
    if (priorMachine === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = priorMachine;
  }
});
test('a browser-free check on a runner with no browser slots passes [C7]', { timeout: 180_000 }, t => browserFreeRunnerCheck(t, { cli, git })); // budget: two runner round trips and two local runs.
test('a test that prints the browser refusal text on a runner stays red and is not rerun [C7]', { timeout: 120_000 }, t => browserRefusalTextStaysRed(t, { cli, git })); // budget: one runner round trip.

test('a refused runner checkout names its failed Git step and stderr [C6,C7]', async t => {
  for (const mode of ['lock', 'missing', 'large', 'filesystem', 'index', 'custom-filesystem']) {
    await t.test(mode, child => sourceSetupFailureFixture(child, { cli, git, runThroughGate, gateResult }, mode));
  }
});

test('a red on a registered runner gets its paired rerun and ledger entry, or stays unclassified without the host load [C7]', { timeout: 300_000 }, async t => {
  for (const mode of ['remote-load', 'no-load', 'paired-no-load']) {
    await t.test(mode, child => runPairedRerun(child, mode, PAIRED_RERUN_FIXTURE));
  }
});

test('the runner round trip deadline holds under a loaded test machine and still catches a stuck phase [C7]',
  { timeout: 660_000, cpuLoad: true }, async t => { // budget: five real paired attempts plus a bounded held phase, below the file hang ceiling.
    await assertAttemptDeadlineReset(PAIRED_RERUN_FIXTURE);
    await assertRedispatchDeadlineAccounting(PAIRED_RERUN_FIXTURE);
    assertFixtureGroupEpermControls();
    const busy = await startRunnerCpuStandIn();
    t.after(busy.stop);
    assert.equal(busy.count, Math.max(1, Math.floor(busy.cores / 2)), 'the fixture owns one busy child for each half-core slot');
    try {
      for (let run = 1; run <= 5; run++) {
        await t.test(`paired rerun ${run} of 5 [C7]`, async child => {
          const observation = await runPairedRerun(child, 'paired-no-load', PAIRED_RERUN_FIXTURE, { cpuLoad: busy });
          assert.equal(observation.paired?.green, true, 'the paired runner rerun makes progress and passes');
          assert.equal(observation.classification, 'unclassified', 'without the paired host load, a green run is not called a flake');
          busy.assertAlive();
        });
      }
      t.diagnostic(JSON.stringify({ cpuStandIn: busy.count, pids: busy.pids, cores: busy.cores,
        loadBefore: Number(busy.loadBefore.toFixed(1)), loadDuring: Number(busy.loadAfter().toFixed(1)), pairedRuns: 5, cpu: busy.report.cpuSnapshots }));
      await t.test('a permanently held result return remains a named bounded failure [C7]', async child => {
        await runPairedRerun(child, 'paired-no-load', PAIRED_RERUN_FIXTURE, { hold: 'return' });
      });
    } finally {
      await busy.stop();
    }
  });
