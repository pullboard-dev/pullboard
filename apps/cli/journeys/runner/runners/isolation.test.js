/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  BIN,
  HOST,
  after,
  assert,
  awaitRoundTrip,
  cli,
  committedToolingSnapshot,
  copyPackageFiles,
  dirname,
  e2e,
  existsSync,
  fixtureResultContext,
  gateResult,
  gateSlotEnvironment,
  git,
  installSshStandIn,
  join,
  listResources,
  mkdirSync,
  mkdtempSync,
  observe,
  phaseCounts,
  readFileSync,
  realpathSync,
  resolve,
  rmSync,
  runFixtureChild,
  runThroughGate,
  shellQuote,
  startFixtureChild,
  startToolingCli,
  takeResource,
  test,
  tmpdir,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/runners.js';
import { scopedEnvironment } from '../../../../runner/src/io/worker/environment.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { chmodSync } from 'node:fs';
import { delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

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

  const suiteRoot = resolve(import.meta.dirname, '../../../../..');
  copyPackageFiles(suiteRoot, toolingRoot);
  git(toolingRoot, env, 'init', '-q', '-b', 'main');
  git(toolingRoot, env, 'add', '.');
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

test('a job whose PATH holds an older global pullboard runs the checkout CLI by name (checkout CLI first) [C7]', () => {
  const files = privateFixtureFiles('runner-checkout-cli-');
  const dir = files.root;
  try {
    const globalBin = join(dir, 'nvm-bin');
    const cli = join(dir, 'checkout/apps/cli/pullboard.js');
    files.write('nvm-bin/pullboard', '#!/bin/sh\necho 0.9.2-global\n');
    files.write('checkout/apps/cli/pullboard.js', "#!/usr/bin/env node\nconsole.log('checkout ' + process.argv.slice(2).join(' '));\n");
    files.write('tmp/keep', '');
    chmodSync(join(globalBin, 'pullboard'), 0o755);
    chmodSync(cli, 0o755);
    const S = { safePath: [globalBin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), workerId: 'job-1' };
    const env = scopedEnvironment(S, join(dir, 'home'), join(dir, 'tmp'), '', null, { gateSlotEnvironment: () => ({}) });
    const run = spawnSync('sh', ['-c', 'command -v pullboard; pullboard --version'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim().split('\n')[0], join(dir, 'cli-bin', 'pullboard'), 'the checkout link is found before the global install');
    assert.match(run.stdout, /checkout --version/u);
    assert.doesNotMatch(run.stdout, /0\.9\.2-global/u);
    const outside = scopedEnvironment(S, join(dir, 'home'), join(dir, 'nowhere/tmp'), '', null, { gateSlotEnvironment: () => ({}) });
    assert.equal(outside.PATH, S.safePath, 'a temporary folder that is not a job leaves PATH alone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
