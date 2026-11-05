/** A gate slot held by a live but hung process is terminated, freed and its captured request re-run once [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { waitForCondition } from './runner-fixture-state.js';

const REPO = resolve(import.meta.dirname, '..');
const RESOURCE = 'liveness-test';

/** A holder that takes the slot with a captured re-run, then idles until it is stopped or killed. */
const HOLDER = `const { writeFileSync } = require('node:fs');
(async () => {
  const { takeResource } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'packages/resources/index.js')).href)});
  const [, , ready, rerun, marker] = process.argv;
  await takeResource({ name: ${JSON.stringify(RESOURCE)}, capacity: 1, scope: 'machine', agent: 'holder',
    capturedRequest: { argv: [process.execPath, rerun, marker] } });
  writeFileSync(ready, String(process.pid));
  setInterval(() => {}, 1000);
})();
`;

/** A re-run that records how often it started and whether it was marked as a re-dispatch. */
const RERUN = `require('node:fs').appendFileSync(process.argv[2], 'ran ' + (process.env.PULLBOARD_LIVENESS_RELAUNCH ?? '') + '\\n');
`;

/** Build a private machine home, the holder and re-run scripts, and the environment that shortens the windows. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-liveness-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  writeFileSync(join(dir, 'holder.cjs'), HOLDER);
  writeFileSync(join(dir, 'rerun.cjs'), RERUN);
  return { dir, home, holderScript: join(dir, 'holder.cjs'), rerunScript: join(dir, 'rerun.cjs') };
}

test('a stale-live holder is terminated, its slot freed and its captured request re-run exactly once [C7]', async t => {
  const { dir, home, holderScript, rerunScript } = fixture(t);
  const env = { PULLBOARD_MACHINE_HOME: home, PULLBOARD_STALE_HOLDER_MS: '1000', PULLBOARD_HOLDER_KILL_GRACE_MS: '500' };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; });
  const { takeResource } = await import(pathToFileURL(join(REPO, 'packages/resources/index.js')).href);

  const ready = join(dir, 'ready');
  const marker = join(dir, 'marker');
  const holder = spawn(process.execPath, [holderScript, ready, rerunScript, marker],
    { detached: true, stdio: 'ignore', env: { ...process.env } });
  let exited = false;
  holder.on('exit', () => { exited = true; });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  await waitForCondition(() => existsSync(ready), 'the holder takes the slot');

  // A stopped process keeps its PID but cannot run its heartbeat timer: alive, and hung.
  process.kill(holder.pid, 'SIGSTOP');
  const lease = await takeResource({ name: RESOURCE, capacity: 1, scope: 'machine', agent: 'waiter' });

  // The slot is freed only once the holder's PID is gone.
  assert.equal(exited, true, 'the terminated holder must be gone before its slot is granted');
  lease.release();

  await waitForCondition(() => existsSync(marker), 'the captured request re-runs');
  const runs = readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(runs, ['ran 1'], 'the captured request runs exactly once, marked as a re-dispatch');

  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  try {
    const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM liveness_event GROUP BY kind').all();
    const count = kind => kinds.find(row => row.kind === kind)?.n ?? 0;
    assert.equal(count('terminate'), 1, 'SIGTERM is sent once');
    assert.equal(count('requeue'), 1, 'the request is re-dispatched once');
    assert.equal(count('requeue-spent'), 0, 'the re-dispatch is never requeued again');
  } finally { db.close(); }
});

/** A holder that takes the slot, then blocks its event loop in a synchronous gate run of the given seconds. */
const BLOCKED = `import { writeFileSync } from 'node:fs';
const { takeResource } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'packages/resources/index.js')).href)});
const { runProfiledShell } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'packages/gate/index.js')).href)});
const [ready, done, root, seconds] = process.argv.slice(2);
const lease = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', agent: 'blocked' });
writeFileSync(ready, lease.token);
const run = runProfiledShell(root, 'sleep ' + seconds, { gateLease: lease });
writeFileSync(done, String(run.exitCode));
lease.release();
`;

/** Start the blocked holder in its own group and wait until it holds the slot; returns its token and paths. */
async function blockedHolder(t, dir, seconds) {
  writeFileSync(join(dir, 'blocked.mjs'), BLOCKED);
  // A gate run reads its log path from Git, so the run's root is a real repository.
  spawnSync('git', ['init', '--quiet', dir]);
  const ready = join(dir, 'blocked-ready');
  const done = join(dir, 'blocked-done');
  const holder = spawn(process.execPath, [join(dir, 'blocked.mjs'), ready, done, dir, String(seconds)],
    { detached: true, stdio: 'ignore', env: { ...process.env } });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  await waitForCondition(() => existsSync(ready) && readFileSync(ready, 'utf8').length > 0, 'the blocked holder takes the slot');
  return { holder, token: readFileSync(ready, 'utf8'), done };
}

/** Whether any process still carries this lease token in its arguments, which only the heartbeat helper does. */
function helperRunning(token) {
  const { stdout } = spawnSync('/bin/ps', ['-axwwo', 'args='], { encoding: 'utf8' });
  return stdout.split('\n').some(line => line.includes(token));
}

/** Set the shortened liveness windows for one test and restore them after it. */
function shortWindows(t, home) {
  const env = { PULLBOARD_MACHINE_HOME: home, PULLBOARD_STALE_HOLDER_MS: '1500', PULLBOARD_HOLDER_KILL_GRACE_MS: '500', PULLBOARD_BLOCKED_HEARTBEAT_MS: '200' };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; });
}

test('a holder blocked in a synchronous gate run keeps a fresh heartbeat and is never signalled [C7]', async t => {
  const { dir, home } = fixture(t);
  shortWindows(t, home);
  const { takeResource } = await import(pathToFileURL(join(REPO, 'packages/resources/index.js')).href);
  const { token, done } = await blockedHolder(t, dir, 4);
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  t.after(() => db.close());
  let oldest = 0;
  // Each take runs the reclaimer, which would SIGTERM a holder silent past the 1.5 s window.
  const deadline = Date.now() + 15_000;
  while (!existsSync(done) && Date.now() < deadline) {
    const probe = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', agent: 'probe' });
    probe.release();
    const beat = () => db.prepare('SELECT heartbeat FROM holder WHERE token = ?').get(token)?.heartbeat;
    const seen = beat();
    if (seen) oldest = Math.max(oldest, Date.now() - seen);
    // The next probe waits for the next refreshed heartbeat, the run's end, or a freed row.
    await waitForCondition(() => existsSync(done) || beat() !== seen, 'the blocked holder heartbeat refreshes', { signal: AbortSignal.timeout(5_000) });
  }
  assert.equal(existsSync(done) && readFileSync(done, 'utf8'), '0', 'the blocked run completes');
  assert.ok(oldest < 1500, `the holder heartbeat stays inside the hung window while blocked (oldest ${oldest} ms)`);
  const terminated = db.prepare("SELECT COUNT(*) AS n FROM liveness_event WHERE kind = 'terminate'").get().n;
  assert.equal(terminated, 0, 'the blocked holder is never signalled');
});

test('the out-of-loop heartbeat stops once the run returns and once its holder dies [C7]', async t => {
  const { dir, home } = fixture(t);
  shortWindows(t, home);
  const returned = await blockedHolder(t, dir, 1);
  await waitForCondition(() => existsSync(returned.done), 'the short run returns');
  await waitForCondition(() => !helperRunning(returned.token), 'the helper stops within 5 s of the run returning', { signal: AbortSignal.timeout(5_000) });

  const killedDir = join(dir, 'killed');
  mkdirSync(killedDir);
  const killed = await blockedHolder(t, killedDir, 30);
  await waitForCondition(() => helperRunning(killed.token), 'the helper runs while the holder is blocked');
  process.kill(killed.holder.pid, 'SIGKILL');
  await waitForCondition(() => !helperRunning(killed.token), 'the helper stops within 5 s of its holder dying', { signal: AbortSignal.timeout(5_000) });
});

test('a holder whose blocking call outlives the helper deadline goes stale and is reclaimed [C7]', async t => {
  const { dir, home } = fixture(t);
  shortWindows(t, home);
  // An untimed call gets only this refresh window; a call that never returns must still go stale.
  process.env.PULLBOARD_BLOCKED_UNTIMED_LIMIT_MS = '1000';
  t.after(() => { delete process.env.PULLBOARD_BLOCKED_UNTIMED_LIMIT_MS; });
  const { takeResource } = await import(pathToFileURL(join(REPO, 'packages/resources/index.js')).href);
  const { holder, token } = await blockedHolder(t, dir, 60);
  let exited = false;
  holder.on('exit', () => { exited = true; });
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  t.after(() => db.close());
  const terminated = () => db.prepare("SELECT COUNT(*) AS n FROM liveness_event WHERE kind = 'terminate'").get().n > 0;
  // Each take runs the reclaimer; the next one waits for the holder's heartbeat to change or its row to go.
  const signal = AbortSignal.timeout(15_000);
  while (!terminated() && !signal.aborted) {
    const probe = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', agent: 'probe' });
    probe.release();
    const seen = db.prepare('SELECT heartbeat FROM holder WHERE token = ?').get(token)?.heartbeat;
    await waitForCondition(() => terminated() || db.prepare('SELECT heartbeat FROM holder WHERE token = ?').get(token)?.heartbeat !== seen
      || helperRunning(token) === false, 'the helper deadline passes', { signal });
  }
  assert.equal(terminated(), true, 'the hung holder is signalled once the helper deadline has passed');
  await waitForCondition(() => exited, 'the hung holder exits', { signal: AbortSignal.timeout(15_000) });
});

/** A holder that blocks in a bare spawnSync, outside runProfiledShell, the way runOnRunner and Git scans do. */
const BARE = `import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const { takeResource } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'packages/resources/index.js')).href)});
const [ready, done, , seconds] = process.argv.slice(2);
const lease = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', agent: 'bare' });
writeFileSync(ready, lease.token);
const run = spawnSync('sleep', [seconds]);
writeFileSync(done, String(run.status));
lease.release();
`;

test('any holder blocked in synchronous child work keeps a fresh heartbeat from its lease, with no call-site helper [C7]', async t => {
  const { dir, home } = fixture(t);
  shortWindows(t, home);
  writeFileSync(join(dir, 'bare.mjs'), BARE);
  const ready = join(dir, 'bare-ready'), done = join(dir, 'bare-done');
  const holder = spawn(process.execPath, [join(dir, 'bare.mjs'), ready, done, dir, '4'], { detached: true, stdio: 'ignore', env: { ...process.env } });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  await waitForCondition(() => existsSync(ready) && readFileSync(ready, 'utf8').length > 0, 'the bare holder takes the slot');
  const token = readFileSync(ready, 'utf8');
  const { takeResource } = await import(pathToFileURL(join(REPO, 'packages/resources/index.js')).href);
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  t.after(() => db.close());
  let oldest = 0;
  const deadline = Date.now() + 15_000;
  while (!existsSync(done) && Date.now() < deadline) {
    const probe = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', agent: 'probe' });
    probe.release();
    const beat = () => db.prepare('SELECT heartbeat FROM holder WHERE token = ?').get(token)?.heartbeat;
    const seen = beat();
    if (seen) oldest = Math.max(oldest, Date.now() - seen);
    // Each probe runs the reclaimer; the next one waits for a refreshed heartbeat, which a blocked timer never gives.
    await waitForCondition(() => beat() !== seen, 'the bare holder heartbeat refreshes while blocked', { signal: AbortSignal.timeout(1_500) });
  }
  assert.equal(existsSync(done) && readFileSync(done, 'utf8'), '0', 'the blocked child work completes');
  assert.ok(oldest < 1500, `the holder heartbeat stays inside the hung window (oldest ${oldest} ms)`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM liveness_event WHERE kind = 'terminate'").get().n, 0, 'the blocked holder is never signalled');
  await waitForCondition(() => !helperRunning(token), 'the lease helper stops once the lease is released', { signal: AbortSignal.timeout(5_000) });
});
