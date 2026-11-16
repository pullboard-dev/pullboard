/** A runner job's detached processes end with the job, and a cleanup it cannot verify reruns locally [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { takeResource } from '../../../../../packages/resources/index.js';
import { runFixtureChild } from '../child.js';
import {
  readRemoteGateHolders,
  waitForCondition,
} from './holders.js';

/** The committed job: on the runner it leaves a detached child and grandchild behind, or overflows its spawn journal. */
const JOB = `import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [out, remoteRoot] = process.argv.slice(2);
const mode = readFileSync(new URL('./mode.txt', import.meta.url), 'utf8').trim();
const option = /(?:^|\\s)--import=(?:"([^"]+)"|'([^']+)'|(\\S+))/u.exec(process.env.NODE_OPTIONS || '');
const preload = option ? fileURLToPath(option[1] || option[2] || option[3]) : '';
if (!preload.startsWith(remoteRoot)) { writeFileSync(join(out, mode + '-local'), 'local\\n'); console.log('ran locally'); process.exit(0); }
writeFileSync(join(out, mode + '-remote'), 'remote\\n');
if (mode === 'overflow') { writeFileSync(join(dirname(preload), 'child-journal', 'overflow'), 'fixture overflow\\n'); process.exit(0); }
// A launcher that exits as soon as it spawns, so no census sees the detached child beside its parent.
spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, [process.argv[1], process.argv[2]], { detached: true, stdio: 'ignore' }).unref(); process.exit(0);",
  fileURLToPath(new URL('./orphan-child.mjs', import.meta.url)), out], { stdio: 'ignore' });
const deadline = Date.now() + 10_000;
while (!existsSync(join(out, 'grandchild.pid')) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
console.log('left a detached child and grandchild');
`;
const CHILD = `import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [out] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
grandchild.unref();
writeFileSync(join(out, 'child.pid'), String(process.pid));
writeFileSync(join(out, 'grandchild.tmp'), String(grandchild.pid));
renameSync(join(out, 'grandchild.tmp'), join(out, 'grandchild.pid'));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

/**
 * Run the gate twice on a stand-in SSH runner while the only local slot is held. The first job's launcher starts a
 * detached child and exits at once, so no census sees the two together, and the child starts a detached grandchild.
 * The runner must still end both by the exact start each spawn receipt recorded, verify that, and return green.
 * The second job makes its cleanup unverifiable; the run must rerun locally, not fail.
 */
export async function runnerOrphanFixture(t, tools) {
  const { cli, git, installSshStandIn, observe, startToolingCli, processIsAlive, HOST } = tools;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-orphans-')));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteStateRoot = join(remoteHome, '.pullboard-runner');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const remoteDatabase = join(remoteMachineHome, 'resources.sqlite');
  const repo = join(dir, 'repo');
  const out = join(dir, 'out');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const starts = join(dir, 'ssh-starts.jsonl');
  const workerLog = join(dir, 'worker-stderr.log');
  const pidIn = name => existsSync(join(out, name)) ? Number(readFileSync(join(out, name), 'utf8')) : 0;
  let running;
  let held;
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  t.after(async () => {
    if (running && running.exitCode === null && running.signalCode === null) {
      try { process.kill(-running.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') t.diagnostic(`fixture group: ${error.message}`); }
      await once(running, 'close').catch(error => t.diagnostic(`fixture child close: ${error.message}`));
    }
    // A failing run must not leave its own orphans behind either.
    for (const pid of [pidIn('child.pid'), pidIn('grandchild.pid')]) {
      if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') t.diagnostic(`fixture orphan: ${error.message}`); }
    }
    held?.release();
    for (const [key, value] of [['PULLBOARD_HOME', previous[0]], ['PULLBOARD_MACHINE_HOME', previous[1]]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const folder of [repo, out, worker, bin, home, machineHome, remoteHome, remoteStateRoot, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Orphan Fixture', GIT_AUTHOR_EMAIL: 'runner-orphans@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Orphan Fixture', GIT_COMMITTER_EMAIL: 'runner-orphans@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: `node orphan-job.mjs ${JSON.stringify(out)} ${JSON.stringify(remoteStateRoot)}` }));
  writeFileSync(join(repo, 'orphan-job.mjs'), JOB);
  writeFileSync(join(repo, 'orphan-child.mjs'), CHILD);
  writeFileSync(join(repo, 'mode.txt'), 'detached\n');
  git(repo, env, 'add', 'pullboard.json', 'orphan-job.mjs', 'orphan-child.mjs', 'mode.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: a job that leaves detached processes behind');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests: join(dir, 'ssh-requests.jsonl'), starts, stderrLog: workerLog });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
    agent: 'orphan-local-holder', item: 'orphan-local-holder', kind: 'fixture-hold', browser: true });
  /** One gate run through the real CLI; `whenRemote` runs once the runner's job body has started. */
  const gate = async (whenRemote) => {
    running = startToolingCli(repo, env, ['gate', '--json'], { detached: true });
    const run = observe(running);
    if (whenRemote) { await waitForCondition(() => existsSync(join(out, 'overflow-remote')), 'the overflow job ran on the runner'); whenRemote(); }
    const completed = await run.closed;
    return { ...completed, context: `${completed.stderr}\n${completed.stdout}` };
  };

  const first = await gate();
  assert.equal(first.status, 0, first.context);
  assert.ok(existsSync(join(out, 'detached-remote')) && !existsSync(join(out, 'detached-local')), 'the first job ran on the runner only');
  const [child, grandchild] = [pidIn('child.pid'), pidIn('grandchild.pid')];
  assert.ok(child > 0 && grandchild > 0 && child !== grandchild, 'the job started a detached child and grandchild');
  await waitForCondition(() => !processIsAlive(child) && !processIsAlive(grandchild), 'the runner ended the detached child and grandchild',
    { state: () => ({ child: processIsAlive(child), grandchild: processIsAlive(grandchild) }) });
  const log = existsSync(workerLog) ? readFileSync(workerLog, 'utf8') : '';
  assert.doesNotMatch(log, /PULLBOARD_RUNNER_CLEANUP_(?:UNVERIFIED|TIMEOUT)/u, 'the runner verified its cleanup from its own record');

  writeFileSync(join(repo, 'mode.txt'), 'overflow\n');
  git(repo, env, 'commit', '-q', '-m', 'test: a job whose cleanup cannot be verified', '--', 'mode.txt');
  const second = await gate(() => { held.release(); held = null; });
  assert.equal(second.status, 0, second.context);
  const local = new DatabaseSync(join(machineHome, 'resources.sqlite'), { readOnly: true });
  try {
    assert.equal(local.prepare('SELECT detail FROM runner_unavailable WHERE host = ?').get(HOST)?.detail, 'CLEANUP_UNVERIFIED',
      'the runner whose cleanup was unverified is out of the queue until checked, by name');
  } finally { local.close(); }
  assert.ok(existsSync(join(out, 'overflow-local')), 'the run whose runner cleanup was unverified reran locally');
  assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 2, 'each run reached the runner once and was never retried there');
  const retained = readdirSync(join(remoteStateRoot, 'jobs')).filter(name => existsSync(join(remoteStateRoot, 'jobs', name, 'cleanup-timeout.json')));
  assert.equal(retained.length, 1, 'the runner kept the unverified job for inspection');
  assert.match(readFileSync(join(remoteStateRoot, 'jobs', retained[0], 'cleanup-timeout.json'), 'utf8'), /child spawn journal overflow/u);
  await waitForCondition(() => readRemoteGateHolders(remoteDatabase).length === 0, 'the runner gate holder releases after its cleanup timeout');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One census row as `ps -axo pid=,ppid=,pgid=,lstart=,stat=,comm=` prints it under TZ=UTC. */
function censusLine(pid, ppid, pgid, ms) {
  const d = new Date(ms);
  const time = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(part => String(part).padStart(2, '0')).join(':');
  return `${pid} ${ppid} ${pgid} ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${time} ${d.getUTCFullYear()} S node`;
}

/**
 * Drive the runner's custody through a scripted census and a recording kill; pids sit above any real pid_max. The
 * runner adopts only what it can prove exactly, so these must never be signalled (#1063):
 * - a job process spawned a child and exited, and a foreign process holds that pid, born the same second, with a
 *   different exact start than the receipt recorded;
 * - a process with no receipt whose parent is gone (what the journal cannot cover: a child of a non-Node process);
 * - a job group's members all exited, and a foreign leader holds that group number, born the same second as the old one.
 */
export async function unprovenProcessFixture(t, { createDescendantTracker, parseProcessCensus }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-unproven-')));
  const self = 9_000_001;
  const root = 9_000_010;
  const parent = 9_000_050;
  const reusedPid = 9_000_060;
  const leader = 9_000_100;
  const member = 9_000_101;
  const foreignMember = 9_000_102;
  const stranger = 9_000_070;
  const now = Date.now();
  const line = (pid, ppid, pgid) => censusLine(pid, ppid, pgid, now);
  let rows = [censusLine(self, 1, self, now - 60_000)];
  const kills = [];
  const kill = (pid, signal) => {
    kills.push({ pid, signal });
    // A signalled process leaves the census, as a killed one would.
    rows = rows.filter(entry => { const [rowPid, , rowGroup] = entry.split(' ').map(Number); return pid < 0 ? rowGroup !== -pid : rowPid !== pid; });
  };
  // A lookalike leaves custody uncertain, so the stop loop waits for the cleanup budget; end that budget with the test.
  let budgetSpent = false;
  // Each scripted pid's exact kernel start; the lookalike holds the child's pid but started later.
  const starts = new Map([[reusedPid, 'mac:1792741000.000200'], [stranger, 'mac:1792741000.000300']]);
  const tracker = createDescendantTracker(dir, { census: () => parseProcessCensus(rows.join('\n')), kill, selfPid: self,
    timedOut: () => budgetSpent, intervalMs: 3_600_000, startOf: pid => starts.get(pid) ?? '' });
  // End the budget and let the stop loop return before its journal directory goes.
  t.after(async () => {
    budgetSpent = true;
    let timer;
    await Promise.race([tracker.stopDescendants(), new Promise(done => { timer = setTimeout(done, 3_000); })]); // budget: one census pass after the budget ends.
    clearTimeout(timer);
    tracker.stopMonitoring();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Stop descendants within a bound, then report what was signalled and what is in custody. */
  const stop = async () => {
    let timer;
    await Promise.race([tracker.stopDescendants(), new Promise(done => { timer = setTimeout(done, 3_000); })]); // budget: nothing to stop returns at once.
    clearTimeout(timer);
    return { kills: [...kills], live: tracker.cleanupState().live.map(entry => entry.pid) };
  };

  rows = [...rows, line(root, self, root)];
  tracker.registerRoot(root);
  // The job's own parent records that it spawned a child, then exits; a foreign process born that second holds the pid.
  writeFileSync(join(dir, 'child-journal', `children-${parent}.jsonl`), [
    { type: 'boot', pid: parent, ppid: root, instance: 'fixture-parent' },
    { type: 'spawn', pid: reusedPid, ppid: parent, instance: 'fixture-parent', commandSha256: 'a'.repeat(64), start: 'mac:1792741000.000100' },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  rows = [...rows, line(reusedPid, 1, reusedPid)];
  tracker.observe();
  assert.deepEqual(await stop().then(state => state.kills), [], 'a reused pid never matches the exact start its receipt recorded');
  assert.deepEqual(tracker.cleanupState().pending.map(entry => entry.pid), [], 'a different exact start proves the lookalike is foreign and cannot hold cleanup');
  rows = rows.filter(entry => Number(entry.split(' ')[0]) !== reusedPid);
  tracker.observe();

  // Not covered: a descendant started by a process that is not Node has no receipt, since only Node writes the
  // journal. Seen first after its parent exited, it cannot be told from a foreign process, so it is never signalled.
  rows = [...rows, line(stranger, 1, stranger)];
  tracker.observe();
  assert.deepEqual(await stop().then(state => state.kills), [], 'a process with no receipt and no live job ancestry is never signalled');
  assert.deepEqual(tracker.cleanupState().live, [], 'nor taken into custody');
  rows = rows.filter(entry => Number(entry.split(' ')[0]) !== stranger);
  tracker.observe();

  // A detached group the job proved by ancestry; its leader exits, then its last member.
  rows = [...rows, line(leader, root, leader), line(member, leader, leader)];
  tracker.observe();
  assert.deepEqual(tracker.cleanupState().live.map(entry => entry.pid).sort(), [leader, member], 'live ancestry proves the job group');
  rows = rows.filter(entry => Number(entry.split(' ')[0]) !== leader).map(entry => Number(entry.split(' ')[0]) === member ? line(member, 1, leader) : entry);
  tracker.observe();
  assert.deepEqual(tracker.cleanupState().live.map(entry => entry.pid), [member], 'a proven member keeps its group after the leader exits');
  rows = [...rows.filter(entry => Number(entry.split(' ')[0]) !== member), line(leader, 1, leader), line(foreignMember, leader, leader)];
  tracker.observe();
  const after = await stop();
  assert.deepEqual(after.kills, [], 'the runner never signals a group it cannot prove is the job\'s');
  assert.deepEqual(after.live, [], 'no foreign process is taken into custody');
}
