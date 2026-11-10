/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  HOST,
  SECRET,
  after,
  assert,
  cli,
  existsSync,
  gateResult,
  git,
  installSshStandIn,
  join,
  listResources,
  mkdirSync,
  mkdtempSync,
  observe,
  readFileSync,
  readRemoteGateHolders,
  realpathSync,
  rmSync,
  runFixtureChild,
  shellQuote,
  startQueueController,
  takeResource,
  test,
  tmpdir,
  waitForCondition,
  waitForMarker,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/runners.js';

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
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, dropFirst: true, healthDown: true });
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
(async()=>{ fs.appendFileSync(${JSON.stringify(order)}, 'retry-first\\n'); fs.writeFileSync(${JSON.stringify(firstStarted)}, 'started\\n');
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
    const observedCalls = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(observedCalls.length >= 2, 'the failed dispatch has a confirming health observation');
    assert.ok(observedCalls.slice(1).every(call => call.healthProbeFailed), 'only health observations contact the quarantined host; no duplicate test execution');
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

  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, healthDown: true, dropAfterMarker: setupReady });
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
    const observedCalls = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(observedCalls.length >= 2);
    assert.ok(observedCalls.slice(1).every(call => call.healthProbeFailed), 'health observations never stand in for setup custody');
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
