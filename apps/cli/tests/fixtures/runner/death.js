/** Exercise actual remote parent-death custody, optionally holding the database so the release queues [C7]. */
import assert from 'node:assert/strict';
import { fixtureMachineSettings } from '../testkit.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { takeResource } from '../../../../../packages/resources/index.js';
import { runFixtureChild } from '../child.js';
import {
  readRemoteGateHolders,
  waitForCondition,
} from './holders.js';

/**
 * Keep the original custody assertions identical in ordinary and forced ordering cases: `holdRelease` holds the database so the
 * worker's release queues (#3084) and a later resource write drains it, `chatty` makes the command keep writing output, so some always arrives after the
 * transport drops (#888: a forwarded write then waited forever for a drain from a destroyed stdout), and `epermOnce`
 * arms after the child's TERM handler starts, then makes the worker's next real group signal answer EPERM (#945).
 * The marker is a fixture phase, not an OS-dependent second signal to the same group: the worker's fresh-census retry
 * (#888) must still drain its owned groups and release its lease. The launcher handles TERM without exiting until a
 * real TERM arrives after the refusal, so Linux's launcher-first ordering also leaves a live group to signal.
 * `lateGroup` starts the child in the launcher's group and moves it to its own a second later, so the worker's census
 * always sees it first in the old group, as it did under load when a detached child had not yet called setsid (#888).
 */
export async function parentDeathDrainFixture(t, tools, { holdRelease = false, chatty = false, epermOnce = false, lateGroup = false } = {}) {
  const { cli, git, installSshStandIn, observe, startQueueController, waitForMarker, processIsAlive, shellQuote, HOST } = tools;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-parent-death-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const remoteDatabase = join(remoteMachineHome, 'resources.sqlite');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const childReady = join(dir, 'detached-child-ready');
  const childPidFile = join(dir, 'detached-child-pid');
  const childTerm = join(dir, 'detached-child-term');
  const releaseChild = join(dir, 'release-detached-child');
  const childGone = join(dir, 'detached-child-gone');
  const workerLog = join(dir, 'worker-stderr.log');
  const epermAnswered = join(dir, 'eperm-answered');
  let releaseLock;
  /** The worker's own account of a stalled release: its runner status lines and any cleanup files in its private job (#888). */
  function workerCleanupReport() {
    const lines = existsSync(workerLog) ? readFileSync(workerLog, 'utf8').split('\n')
      .filter(line => /^PULLBOARD_RUNNER_(?!HEARTBEAT)[A-Z_]+ /u.test(line)).slice(-20) : [];
    const jobs = join(remoteHome, '.pullboard-runner', 'jobs');
    const files = {};
    for (const job of existsSync(jobs) ? readdirSync(jobs) : []) {
      for (const name of ['cleanup-timeout.json', 'release-pending.json']) {
        const file = join(jobs, job, name);
        if (existsSync(file)) files[job + '/' + name] = readFileSync(file, 'utf8').slice(0, 2_000);
      }
    }
    return { lines, files };
  }
  /**
   * Report a stalled wait without replacing its error: the controller's result if it ended within `waitMs`, the ssh
   * stand-in's calls and phases, process liveness, and the worker's cleanup lines and files.
   */
  async function reportStall(stage, waitMs) {
    const deadline = Date.now() + waitMs;
    let ended = null;
    while (Date.now() < deadline) {
      ended ??= await Promise.race([remoteRun.closed, new Promise(done => { setTimeout(() => done(null), 250).unref(); })]); // budget: poll interval inside the bounded wait.
      if (ended && (stage === 'readiness' || Object.keys(workerCleanupReport().files).length > 0)) break;
      if (ended) await new Promise(done => { setTimeout(done, 250); }); // budget: poll interval for the worker's cleanup files.
    }
    const tail = text => String(text ?? '').slice(-4_000);
    t.diagnostic(`controller at ${stage} stall ` + JSON.stringify(ended
      ? { status: ended.status, signal: ended.signal, stdout: tail(ended.stdout), stderr: tail(ended.stderr) } : 'still running'));
    t.diagnostic('ssh stand-in calls ' + (existsSync(requests) ? tail(readFileSync(requests, 'utf8')) : 'none'));
    t.diagnostic('ssh stand-in phases ' + (existsSync(requests + '.phases') ? readFileSync(requests + '.phases', 'utf8').trim().split('\n').join(',') : 'none'));
    const childPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, 'utf8').trim()) : null;
    t.diagnostic('liveness ' + JSON.stringify({ child: childPid && processIsAlive(childPid),
      holders: existsSync(remoteDatabase) ? readRemoteGateHolders(remoteDatabase).map(({ pid, agent }) => ({ pid, agent, alive: processIsAlive(pid) })) : [] }));
    t.diagnostic('worker cleanup report ' + JSON.stringify(workerCleanupReport()));
    if (ended) remoteRun = null;
  }
  /** Release only this fixture's explicit write reservation. */
  function unlockRelease() {
    if (!releaseLock) return;
    releaseLock.exec('ROLLBACK');
    releaseLock.close();
    releaseLock = null;
  }
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome]) {
    mkdirSync(folder, { recursive: true });
  }
  fixtureMachineSettings(machineHome, { gateSlots: 1, gate: { loadAwareDispatch: false } });
  const env = {
    ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Parent Death Fixture', GIT_AUTHOR_EMAIL: 'parent-death@example.invalid',
    GIT_COMMITTER_NAME: 'Parent Death Fixture', GIT_COMMITTER_EMAIL: 'parent-death@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'parent-death runner fixture\n');
  writeFileSync(join(repo, 'remote-parent-death-launcher.js'), `const { spawn } = require('node:child_process');
const child = ${lateGroup
    ? "spawn('perl', ['-e', 'select(undef, undef, undef, 1); setpgrp(0, 0); exec @ARGV', process.execPath, require.resolve('./remote-detached-child.js'), ...process.argv.slice(2)], {\n  stdio: 'ignore', env: process.env,\n});"
    : "spawn(process.execPath, [require.resolve('./remote-detached-child.js'), ...process.argv.slice(2)], {\n  detached: true, stdio: 'ignore', env: process.env,\n});"}
child.unref();
${chatty ? "setInterval(() => process.stdout.write('launcher output\\n'), 20);" : 'setInterval(() => {}, 1_000);'}
${epermOnce ? `// Keep a live group until the worker delivers TERM after its forced refusal, without a timed linger.
process.on('SIGTERM', () => {
  if (require('node:fs').existsSync(${JSON.stringify(epermAnswered)})) process.exit(0);
});` : ''}
`);
  writeFileSync(join(repo, 'remote-detached-child.js'), `const { existsSync, writeFileSync } = require('node:fs');
const [ready, pidFile, term, release, gone] = process.argv.slice(2);
let handlingTerm = false;
process.on('SIGTERM', () => {
  if (handlingTerm) return;
  handlingTerm = true;
  writeFileSync(term, 'term\\n');
  const wait = setInterval(() => {
    if (!existsSync(release)) return;
    clearInterval(wait);
    writeFileSync(gone, 'gone\\n');
    process.exit(0);
  }, 5);
});
writeFileSync(pidFile, String(process.pid));
writeFileSync(ready, 'ready\\n');
setInterval(() => {}, 1_000);
`);
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt', 'remote-parent-death-launcher.js', 'remote-detached-child.js');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare committed detached-child launchers');
  let nodeOptions = '';
  if (epermOnce) {
    const preload = join(dir, 'eperm-once.mjs');
    writeFileSync(preload, `import { existsSync, writeFileSync } from 'node:fs';
const kill = process.kill.bind(process);
let answered = false;
process.kill = (pid, signal) => {
  // Keep initial TERM delivery available to the child's controlled handler. Once it starts, force the next actual
  // group signal, even when Linux signals each group only once (#945). This uses the fixture's explicit phase,
  // not a second call to the same group or an artificial launcher delay. Liveness probes still pass through.
  if (!answered && pid < 0 && signal !== 0 && existsSync(${JSON.stringify(childTerm)})) {
    answered = true;
    writeFileSync(${JSON.stringify(epermAnswered)}, 'eperm\\n');
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' });
  }
  return kill(pid, signal);
};
`);
    nodeOptions = '--import=' + pathToFileURL(preload).href;
  }
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, stderrLog: workerLog, nodeOptions });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let localHold;
  let remoteRun;
  let detachedPid;
  let remoteAgent;
  try {
    localHold = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'parent-death-local-holder', item: 'parent-death-local-holder', kind: 'fixture-hold', browser: true });
    const command = ['node remote-parent-death-launcher.js', ...[childReady, childPidFile, childTerm, releaseChild, childGone].map(shellQuote)].join(' ');
    remoteRun = observe(startQueueController(repo, env, command,
      { item: 'parent-death-remote-holder', queueMarker: null, firstItem: null }));
    try { await waitForMarker(childReady); }
    catch (error) {
      // An early controller exit leaves the detached child unstarted; report why before cleanup erases it (#888 review).
      await reportStall('readiness', 5_000); // budget: bounded wait for an already-failing controller to report its result.
      throw error;
    }
    detachedPid = Number(readFileSync(childPidFile, 'utf8').trim());
    assert.ok(Number.isSafeInteger(detachedPid) && detachedPid > 0);
    assert.notEqual(detachedPid, remoteRun.child.pid, 'the committed launcher owns a separate detached child');
    assert.equal(processIsAlive(detachedPid), true);
    const held = readRemoteGateHolders(remoteDatabase);
    assert.equal(held.length, 1, 'the remote worker keeps its physical gate holder while the launcher is live');
    remoteAgent = held[0].agent;
    assert.match(remoteAgent, /^pullboard-ssh-/u);

    remoteRun.child.kill('SIGTERM');
    try { await waitForMarker(childTerm); }
    catch (error) {
      // The worker never signalled the child: wait out its 30-second cleanup budget so its own cleanup-timeout.json says why.
      await reportStall('child TERM', 15_000); // budget: the rest of the worker's declared 30-second cleanup budget.
      throw error;
    }
    assert.equal(processIsAlive(detachedPid), true, 'the detached child remains alive in its controlled TERM handler');
    const duringDrain = readRemoteGateHolders(remoteDatabase);
    assert.equal(duringDrain.length, 1);
    assert.equal(duringDrain[0].agent, remoteAgent, 'the physical runner lease remains held during descendant cleanup');

    if (holdRelease) {
      releaseLock = new DatabaseSync(remoteDatabase);
      releaseLock.exec('PRAGMA busy_timeout = 10000');
      releaseLock.exec('BEGIN IMMEDIATE');
    }
    writeFileSync(releaseChild, 'release\n');
    await waitForMarker(childGone);
    await waitForCondition(() => !processIsAlive(detachedPid), 'the detached child PID exits');
    if (holdRelease) {
      // Since #3084 a release enqueues its resource write and never throws, so the write waits in the queue while the raw lock stays held.
      const queued = () => existsSync(remoteDatabase + '.writes') && readdirSync(remoteDatabase + '.writes').filter(name => name.includes('-o-')).length;
      await waitForCondition(() => queued() > 0,
        'the worker queues its release behind the held database transaction',
        { signal: t.signal, state: () => ({ workerAlive: processIsAlive(held[0].pid), queued: queued(),
          holders: readRemoteGateHolders(remoteDatabase).map(({ pid, agent, kind }) => ({ pid, agent, kind })) }),
          onTimeout: message => t.diagnostic(message) });
      assert.equal(readRemoteGateHolders(remoteDatabase).some(holder => holder.agent === remoteAgent), true,
        'the holder remains until the queued release can commit');
      unlockRelease();
      // The release lands when the next resource write drains the queue: take and release an unrelated machine resource on the worker's database.
      process.env.PULLBOARD_MACHINE_HOME = remoteMachineHome;
      try { (await takeResource({ name: 'drain-probe', capacity: 1, scope: 'machine', agent: 'drain-probe' })).release(); }
      finally { process.env.PULLBOARD_MACHINE_HOME = machineHome; }
      assert.equal(queued(), 0, 'the later write drained the queued release');
    }
    let lastReleaseState = 'not observed';
    await waitForCondition(() => {
      const holders = readRemoteGateHolders(remoteDatabase).filter(holder => holder.agent === remoteAgent);
      lastReleaseState = { observedAt: new Date().toISOString(), holders: holders.map(({ pid, agent, browser, item, kind }) =>
        ({ pid, agent, browser, item, kind, alive: processIsAlive(pid) })) };
      return holders.length === 0;
    }, 'the remote physical gate holder is released after child exit',
    { signal: t.signal, state: () => lastReleaseState, onTimeout: message => {
      t.diagnostic(message);
      t.diagnostic('worker cleanup report ' + JSON.stringify(workerCleanupReport()));
    } });
    if (holdRelease) await waitForCondition(() => !processIsAlive(held[0].pid), 'the worker exits after its queued release lands', { signal: t.signal });
    if (epermOnce) assert.equal(existsSync(epermAnswered), true, 'a group signal really answered EPERM before the release');
    const controller = await remoteRun.closed;
    remoteRun = null;
    assert.equal(controller.signal, 'SIGTERM', 'the owned API controller alone received SIGTERM');
  } finally {
    unlockRelease();
    if (localHold) localHold.release();
    writeFileSync(releaseChild, 'cleanup-release\n');
    if (remoteRun && remoteRun.child.exitCode === null && remoteRun.child.signalCode === null) {
      remoteRun.child.kill('SIGTERM');
    }
    if (detachedPid && processIsAlive(detachedPid)) {
      try { process.kill(detachedPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (remoteRun) await remoteRun.closed;
    if (detachedPid) await waitForCondition(() => !processIsAlive(detachedPid), 'fixture detached child cleanup');
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
}
