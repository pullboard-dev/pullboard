/** Long-lived processes start where they can reach the runners, whichever app ran the command [C7,#5699]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { waitForCondition } from '../../../gate/tests/fixtures/runner/holders.js';
import { LAUNCH_LABEL_PREFIX } from '../../index.js';
import { launchJobPlist } from '../../index.js';
import { spawnReachable } from '../../index.js';

/** A private machine home, removed after the test. */
function home(t) {
  const root = privateFixtureFiles('pullboard-launch-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A node script that records its own pid and parent pid as JSON in `out`. */
function recorder(out) {
  return ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, marker: process.env.LAUNCH_MARKER }))`];
}

test('clause 1: on macOS the lander wake runs as a launchd job, so launchd is its parent and responsible process; a later launch boots the finished job out [C7]',
  { skip: !existsSync('/bin/launchctl') && 'launchd is not on this machine' }, async t => {
    const root = home(t), out = join(root, 'first.json');
    const first = await spawnReachable(process.execPath, recorder(out), { home: root, env: { ...process.env, LAUNCH_MARKER: 'kept' } });
    if (!first.launchd) { t.skip('no launchd gui session on this host; clauses 2 and 3 cover the plain-spawn fallback'); return; }
    assert.equal(first.launchd, true, 'launchd started it');
    assert.ok(first.label.startsWith(LAUNCH_LABEL_PREFIX));
    await waitForCondition(() => existsSync(out), 'the launched process wrote its record');
    const seen = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(seen.pid, first.pid, 'the returned pid is the process itself');
    assert.equal(seen.ppid, 1, 'launchd is the parent, not the app that ran the command');
    assert.equal(seen.marker, 'kept', 'the caller environment reaches the process');
    /** Whether a pid still names a live process. */
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitForCondition(() => !alive(first.pid), 'the first process ended');
    const second = await spawnReachable(process.execPath, recorder(join(root, 'second.json')), { home: root });
    t.after(() => spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${second.label}`], { stdio: 'ignore' }));
    const loaded = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${first.label}`], { stdio: 'ignore' }).status;
    assert.notEqual(loaded, 0, 'the finished first job was booted out');
    assert.deepEqual(readdirSync(join(root, 'launchd')), [`${second.label}.plist`], 'only the newer job file remains');
  });

test('clause 2: without launchd the process is a plain detached spawn that still writes its log [C7]', async t => {
  const root = home(t), log = join(root, 'out.log');
  const started = await spawnReachable(process.execPath, ['-e', 'console.log("hello from the daemon")'], { home: root, log, launchd: false });
  assert.equal(started.launchd, false);
  assert.ok(Number.isSafeInteger(started.pid));
  await waitForCondition(() => existsSync(log) && readFileSync(log, 'utf8').includes('hello from the daemon'), 'the daemon wrote its log');
  assert.equal(existsSync(join(root, 'launchd')), false, 'no launchd job file is written');
});

test('clause 2: when the gui bootstrap fails the plain spawn runs the job and reports launchd false [C7]', async t => {
  const root = home(t), out = join(root, 'job.json'), calls = [];
  const launcher = async args => { calls.push(args[0]); return { status: 5, stdout: '' }; };
  const started = await spawnReachable(process.execPath, recorder(out), { home: root, launchd: true, launcher });
  assert.equal(started.launchd, false, 'the fallback reports launchd false');
  assert.ok(calls.includes('bootstrap'), 'launchd was tried first');
  await waitForCondition(() => existsSync(out), 'the plain-spawned job wrote its record');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).pid, started.pid, 'the returned pid is the job itself');
  assert.deepEqual(readdirSync(join(root, 'launchd')), [], 'the refused job file is removed');
});

test('clause 3: a runner with no gui session still runs the job, whatever launchctl answers [C7]', async t => {
  const root = home(t), out = join(root, 'job.json');
  const launcher = async () => ({ status: 113, stdout: 'Could not find domain for gui' });
  const started = await spawnReachable(process.execPath, recorder(out), { home: root, launchd: true, launcher });
  assert.equal(started.launchd, false);
  await waitForCondition(() => existsSync(out), 'the job ran without a gui session');
});

test('clause 2: the job file escapes its strings and runs the command once [C7]', () => {
  const plist = launchJobPlist('dev.pullboard.daemon.x', ['/bin/node', 'a<b&"c"'], { cwd: '/tmp', env: { K: 'v>w', N: undefined }, log: '/tmp/l' });
  assert.match(plist, /<string>a&lt;b&amp;&quot;c&quot;<\/string>/u);
  assert.match(plist, /<key>K<\/key><string>v&gt;w<\/string>/u);
  assert.doesNotMatch(plist, /<key>N<\/key>/u, 'an unset variable is left out');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u);
  assert.doesNotMatch(plist, /KeepAlive/u, 'the job never restarts');
});
