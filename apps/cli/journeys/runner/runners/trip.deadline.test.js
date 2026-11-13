/** A queued runner run finishes or fails by name within its deadline, split from trip.test.js to stay under the file budget [C7]. */
import {
  HOST,
  assert,
  cli,
  fixtureResultContext,
  gateResult,
  git,
  installSshStandIn,
  join,
  mkdirSync,
  mkdtempSync,
  parseProcessCensus,
  phaseCounts,
  processesUnder,
  realpathSync,
  rmSync,
  runFixtureChild,
  runThroughGate,
  shellQuote,
  takeResource,
  test,
  tmpdir,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/runners.js';

/** Register the stand-in runner; its 3 s product probe budget can lapse while a loaded machine boots the stand-in, so a failed probe is retried (a refused add registers nothing). */
function addRunner(repo, env) {
  let added;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
    if (added.status === 0) break;
  }
  return added;
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
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { runnerDispatch: 'controller', loadAwareDispatch: false } }));
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
  const added = addRunner(repo, env);
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
    // A loaded runner can spend most of the default 20 s dispatch deadline starting the controller, so this case widens only that phase.
    await heldAt('run', 'remote run', { dispatch: 90_000 }, 150_000);
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
