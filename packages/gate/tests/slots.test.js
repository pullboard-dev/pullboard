/** @pullboard-test-loads packages/resources/index.js packages/gate/index.js packages/resources/src/io/liveness.js packages/resources/src/io/runner/pick.js */
/** A gate slot held by a live but hung process is terminated, freed and its captured request re-run once [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { waitForCondition } from './fixtures/runner/holders.js';

const REPO = resolve(import.meta.dirname, '../../..');
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

test('clause 2: a holder whose process dies is freed at once and its captured request re-run exactly once [C7]', async t => {
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

  // The OS decides: once the holder's PID is gone, the next take frees its slot without waiting on any heartbeat window.
  process.kill(holder.pid, 'SIGKILL');
  await waitForCondition(() => exited, 'the holder process is gone');
  const lease = await takeResource({ name: RESOURCE, capacity: 1, scope: 'machine', agent: 'waiter' });
  lease.release();

  await waitForCondition(() => existsSync(marker), 'the captured request re-runs');
  const runs = readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(runs, ['ran 1'], 'the captured request runs exactly once, marked as a re-dispatch');

  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  try {
    const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM liveness_event GROUP BY kind').all();
    const count = kind => kinds.find(row => row.kind === kind)?.n ?? 0;
    assert.equal(count('terminate'), 0, 'no holder is ever signalled');
    assert.equal(count('freed'), 1, 'the dead holder is freed once');
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
  // The holder refreshes this row while the test reads it; the reader waits out its short write locks.
  db.exec('PRAGMA busy_timeout = 2000');
  t.after(() => db.close());
  let oldest = 0;
  // Each take runs the reclaimer, which would SIGTERM a holder silent past the 1.5 s window.
  const deadline = Date.now() + 15_000;
  while (!existsSync(done) && Date.now() < deadline) {
    const probe = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', agent: 'probe' });
    probe.release();
    // The real beat lives in `beat`; `heartbeat` stays pinned for older readers (#3164).
    const beat = () => db.prepare('SELECT beat FROM holder WHERE token = ?').get(token)?.beat;
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

/** A slot database with only the columns the reclaimer reads, and one holder row. */
function holderDb(t, row) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE holder(token TEXT PRIMARY KEY, name TEXT, pid INTEGER, started TEXT, item TEXT, heartbeat INTEGER, terminating INTEGER DEFAULT 0, request TEXT DEFAULT '', relaunched INTEGER DEFAULT 0, agent TEXT DEFAULT '', repo TEXT DEFAULT '', kind TEXT DEFAULT '');
    CREATE TABLE liveness_event(at TEXT, kind TEXT, name TEXT, item TEXT, pid INTEGER, detail TEXT)`);
  db.prepare('INSERT INTO holder(token, name, pid, started, item, heartbeat) VALUES (?, ?, ?, ?, ?, ?)').run('t', 'gate', row.pid, row.started, '', row.heartbeat);
  return db;
}

test('clause 1 and clause 2: a local holder is alive while its PID answers with the recorded start, however stale its heartbeat; dead or reused PIDs are freed at once [C7]', async t => {
  const { reclaimHolders } = await import(pathToFileURL(join(REPO, 'packages/resources/src/io/liveness.js')).href);
  const now = Date.now(), ancient = now - 60 * 60_000;
  const held = db => db.prepare('SELECT COUNT(*) AS n FROM holder').get().n;
  const blocked = holderDb(t, { pid: 4242, started: 'Mon Nov  4 01:00:00 2026', heartbeat: ancient });
  reclaimHolders(blocked, now, { alive: () => true, processIdentity: () => ({ started: 'Mon Nov  4 01:00:00 2026', zombie: false }) });
  assert.equal(held(blocked), 1, 'a blocked but alive holder past the old 120 s window keeps its slot');
  const unknown = holderDb(t, { pid: 4243, started: 'Mon Nov  4 01:00:00 2026', heartbeat: ancient });
  reclaimHolders(unknown, now, { alive: () => true, processIdentity: () => null });
  assert.equal(held(unknown), 1, 'an unreadable identity is not proof of death');
  const dead = holderDb(t, { pid: 4244, started: 'Mon Nov  4 01:00:00 2026', heartbeat: now });
  reclaimHolders(dead, now, { alive: () => false, processIdentity: () => assert.fail('a dead PID needs no identity') });
  assert.equal(held(dead), 0, 'a dead PID is freed at once, even with a fresh heartbeat');
  const reused = holderDb(t, { pid: 4245, started: 'Mon Nov  4 01:00:00 2026', heartbeat: now });
  reclaimHolders(reused, now, { alive: () => true, processIdentity: () => ({ started: 'Mon Nov  4 02:30:00 2026', zombie: false }) });
  assert.equal(held(reused), 0, 'a reused PID with a different start time is freed at once');
  const zombie = holderDb(t, { pid: 4246, started: 'Mon Nov  4 01:00:00 2026', heartbeat: now });
  reclaimHolders(zombie, now, { alive: () => true, processIdentity: () => ({ started: 'Mon Nov  4 01:00:00 2026', zombie: true }) });
  assert.equal(held(zombie), 0, 'a zombie is gone');
  const fallback = holderDb(t, { pid: 4247, started: 'Mon Nov  4 01:00:00 2026', heartbeat: ancient });
  reclaimHolders(fallback, now, { alive: () => true, processIdentity: () => ({ started: 'linux:1730000000:123456', zombie: false }) });
  assert.equal(held(fallback), 1, 'a ps failure that falls back to another start source never reclaims a live holder');
  const failed = holderDb(t, { pid: 4248, started: 'Mon Nov  4 01:00:00 2026', heartbeat: ancient });
  reclaimHolders(failed, now, { alive: () => true, processIdentity: () => null });
  assert.equal(held(failed), 1, 'an unreadable start keeps a live holder');
  const own = holderDb(t, { pid: process.pid, started: 'Mon Nov  4 01:00:00 2026', heartbeat: now });
  reclaimHolders(own, now, { alive: () => true, processIdentity: () => ({ started: 'Mon Nov  4 03:00:00 2026', zombie: false }) });
  assert.equal(held(own), 0, 'a row naming our own PID with a different start is a dead holder whose PID we reuse');
  const self = holderDb(t, { pid: process.pid, started: 'Mon Nov  4 03:00:00 2026', heartbeat: ancient });
  reclaimHolders(self, now, { alive: () => true, processIdentity: () => ({ started: 'Mon Nov  4 03:00:00 2026', zombie: false }) });
  assert.equal(held(self), 1, 'our own live lease is kept');
  // A stale cache still holds the old process; the PID now belongs to the live holder this row records.
  const cachedOld = holderDb(t, { pid: 4249, started: 'Mon Nov  4 05:00:00 2026', heartbeat: now });
  reclaimHolders(cachedOld, now, { alive: () => true, processIdentity: () => ({ started: 'Mon Nov  4 01:00:00 2026', zombie: false }),
    freshIdentity: () => ({ started: 'Mon Nov  4 05:00:00 2026', zombie: false }) });
  assert.equal(held(cachedOld), 1, 'a stale cached identity is re-read uncached before a live reused PID is freed');
  const confirmed = holderDb(t, { pid: 4250, started: 'Mon Nov  4 05:00:00 2026', heartbeat: now });
  reclaimHolders(confirmed, now, { alive: () => true, processIdentity: () => ({ started: 'Mon Nov  4 01:00:00 2026', zombie: false }),
    freshIdentity: () => ({ started: 'Mon Nov  4 01:00:00 2026', zombie: false }) });
  assert.equal(held(confirmed), 0, 'a mismatch the fresh read confirms is freed');
});

test('clause 1: a really blocked holder past the hung window is never reclaimed while its process lives [C7]', async t => {
  const { dir, home, holderScript, rerunScript } = fixture(t);
  const env = { PULLBOARD_MACHINE_HOME: home };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; });
  const ready = join(dir, 'ready-stopped');
  const holder = spawn(process.execPath, [holderScript, ready, rerunScript, join(dir, 'unused-marker')], { detached: true, stdio: 'ignore', env: { ...process.env } });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  await waitForCondition(() => existsSync(ready), 'the holder takes the slot');
  // A stopped process cannot refresh anything; make its heartbeat far older than the old hung window.
  process.kill(holder.pid, 'SIGSTOP');
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  // The holder refreshes this row while the test reads it; the reader waits out its short write locks.
  db.exec('PRAGMA busy_timeout = 2000');
  t.after(() => db.close());
  db.exec('PRAGMA busy_timeout = 2000');
  db.prepare('UPDATE holder SET heartbeat = ? WHERE pid = ?').run(Date.now() - 10 * 60_000, holder.pid);
  const { takeResource } = await import(pathToFileURL(join(REPO, 'packages/resources/index.js')).href);
  const probe = await takeResource({ name: 'liveness-probe', capacity: 1, scope: 'machine', agent: 'probe' });
  probe.release();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holder WHERE pid = ?').get(holder.pid).n, 1, 'the live holder keeps its slot');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM liveness_event WHERE kind IN ('terminate', 'freed')").get().n, 0, 'and is never signalled or freed');
});

test('clause 3: a runner lease on another host still counts as troubled by its stale heartbeat timestamp [C7]', async t => {
  const { troubledRunners } = await import(pathToFileURL(join(REPO, 'packages/resources/src/io/runner/pick.js')).href);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE holder(name TEXT, runner TEXT, beat INTEGER); CREATE TABLE runner_recovery_event(host TEXT, kind TEXT, at TEXT)`);
  const now = Date.now();
  db.prepare('INSERT INTO holder VALUES (?, ?, ?), (?, ?, ?)').run('runner:far', 'far', now - 10 * 60_000, 'runner:near', 'near', now);
  assert.deepEqual([...troubledRunners(db, now, 60_000)], ['far'], 'only the remote lease whose timestamp stopped is troubled');
});

test('clause 1 and clause 2: controller custody keeps a live holder whose start was read another way, and both reclaim paths share one comparison [C7]', async t => {
  const { differentStart } = await import(pathToFileURL(join(REPO, 'packages/resources/src/io/liveness.js')).href);
  const recorded = 'Mon Nov  4 01:00:00 2026';
  assert.equal(differentStart({ started: 'linux:1730000000:123' }, recorded), false, 'a fallback read after a ps failure is unknown, so alive');
  assert.equal(differentStart({ started: 'win:638000000000000000' }, recorded), false);
  assert.equal(differentStart(null, recorded), false, 'an unreadable identity is alive');
  assert.equal(differentStart({ started: recorded }, ''), false, 'an unrecorded start proves nothing');
  assert.equal(differentStart({ started: 'Mon Nov  4 02:00:00 2026' }, recorded), true, 'the same source with another start is a reused PID');
  assert.equal(differentStart({ started: 'linux:1:2' }, 'linux:1:3'), true);
  const { readFileSync: read } = await import('node:fs');
  const source = read(join(REPO, 'packages/resources/src/io/main.js'), 'utf8');
  const custody = source.slice(source.indexOf('function custodyProcessMatches('), source.indexOf('/** Run a short serialized database update'));
  assert.equal((custody.match(/differentStart\(identity, started\)/gu) ?? []).length, 2, 'the controller orphan prune uses the source-aware comparison');
  assert.doesNotMatch(custody, /identity\.started !== started|identity\.started === started/u);
});
