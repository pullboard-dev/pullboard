/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  DatabaseSync,
  HOST,
  after,
  assert,
  cli,
  existsSync,
  fixtureResultContext,
  gateResult,
  git,
  installSshStandIn,
  join,
  listPreRunnerResources,
  mkdirSync,
  mkdtempSync,
  observe,
  readFileSync,
  realpathSync,
  rmSync,
  runFixtureChild,
  runThroughGate,
  shellQuote,
  startQueueController,
  takePreRunnerResource,
  takeResource,
  test,
  tmpdir,
  waitForMarker,
  writeCacheProbe,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/runners.js';

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
      try { secondBrowser = await secondBrowserPromise; secondBrowser.release(); secondBrowser = null; } catch { /* Teardown must not replace the test failure if the pending browser lease acquisition or release rejects. */ }
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
