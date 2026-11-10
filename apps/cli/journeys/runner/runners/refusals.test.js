/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  HOST,
  after,
  assert,
  cli,
  committedToolingSnapshot,
  existsSync,
  fixtureResultContext,
  gateResult,
  git,
  installSshStandIn,
  join,
  listResources,
  mkdirSync,
  mkdtempSync,
  observe,
  onMachine,
  pathToFileURL,
  readFileSync,
  realpathSync,
  refuseSandboxBlocked,
  resolve,
  rmSync,
  runFixtureChild,
  runThroughGate,
  shellQuote,
  startQueueController,
  takeResource,
  test,
  tmpdir,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/runners.js';

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
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { loadAwareDispatch: false } }));
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
  // Prepare the immutable fixture tooling before measuring the controller's actual refused run.
  committedToolingSnapshot(resolve(import.meta.dirname, '../../../../..'), env);
  // The runner's own pool is busy at more slots than its registration, so the worker's request is refused.
  let remoteHolder = await onMachine(remoteMachineHome, () => takeResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
    agent: 'fixture-remote-holder', item: 'remote-holder', kind: 'force-busy-runner' }));

  // Safe decreases now allow one held slot; occupy both to prove an unsafe shrink is refused.
  let secondRemoteHolder = await onMachine(remoteMachineHome, () => takeResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
    agent: 'fixture-second-remote-holder', item: 'second-remote-holder', kind: 'force-busy-runner' }));

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

    secondRemoteHolder.release();
    secondRemoteHolder = null;
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
    secondRemoteHolder?.release();
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
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { loadAwareDispatch: false } }));
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
