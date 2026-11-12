/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  HOST,
  SECRET,
  TEMP,
  after,
  assert,
  assertWorkerTagBatches,
  cli,
  existsSync,
  fixtureResultContext,
  gateResult,
  git,
  installSshStandIn,
  installWorkerGitWitness,
  join,
  mkdirSync,
  mkdtempSync,
  parseProcessCensus,
  phaseCounts,
  processesUnder,
  readFileSync,
  readRemoteGateHolders,
  realpathSync,
  relative,
  rmSync,
  runFixtureChild,
  runThroughGate,
  sep,
  shellQuote,
  takeResource,
  test,
  tmpdir,
  writeFileSync,
  writeProbe,
} from '../../../tests/fixtures/scenarios/runners.js';

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
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { runnerDispatch: 'controller' } }));
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
  const batchTagObjects = [];
  for (let index = 0; index < 65; index++) {
    const name = `runner-batch/${String(index).padStart(2, '0')}/${'long-name-'.repeat(8)}`;
    if (index % 2) git(repo, env, 'tag', name, historyBaseCommit);
    else git(repo, env, 'tag', '-a', name, '-m', `batch annotation ${index} with UTF-8 🧭`, historyBaseCommit);
    batchTagObjects.push([`refs/tags/${name}`, git(repo, env, 'rev-parse', `refs/tags/${name}`)]);
  }
  git(repo, env, 'tag', '-a', 'runner-nested', '-m', 'nested annotation witness', 'refs/tags/runner-release');
  batchTagObjects.push(['refs/tags/runner-nested', git(repo, env, 'rev-parse', 'refs/tags/runner-nested')]);
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

  const gitWitness = installWorkerGitWitness(dir);
  const ssh = installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, nodeOptions: gitWitness.nodeOptions });
  assert.ok(existsSync(ssh));
  writeProbe(repo, { remoteStateRoot, remoteMachineHome, sourceHome: home, sourceMachineHome: machineHome, historyBaseCommit,
    annotatedTagObject, lightweightTagObject, batchTagObjects,
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
  assertWorkerTagBatches(gitWitness.rows(), ['refs/tags/runner-release', 'refs/tags/runner-lightweight', ...batchTagObjects.map(([ref]) => ref)],
    counts => t.diagnostic(JSON.stringify({ actualWorkerGitCounts: counts })));
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
  assert.equal(phaseCounts(requests + '.phases').dispatched, 3, 'the large-journal command ran remotely exactly once');

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
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { runnerDispatch: 'controller' } }));
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
    await heldAt('return', 'result return', { 'result return': 3_000 }, 15_000);
    // Last: a dispatch that never started leaves its cleanup unverified, and the runner's only slot stays charged for
    // it, so no later round trip on this one runner is admitted.
    await heldAt('dispatch', 'dispatch', { dispatch: 3_000 }, 15_000);
  } finally {
    held?.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});
