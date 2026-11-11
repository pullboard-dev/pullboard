/**
 * A queued gate keeps its queue entry and item lease while a board-blocked renewal holds its process, and a dead gate
 * is still cleaned up [C7]. The queue is a real machine slot database. The renewal blocks the waiter's only thread, as
 * SQLite's busy handler does on a busy board. Queue cleanup runs in a second real process whose clock runs 110 s
 * ahead, so the 120 s cleanup cutoff falls 10 s behind real time and a 20 s block crosses it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  runFixtureChildAsync,
  startFixtureChild,
} from '../../../../apps/cli/tests/fixtures/child.js';
import { takeResource } from '../../index.js';
import { renewWithBeat } from '../../src/io/renewal.js';
import { tuneRenewalBeat } from '../../src/io/renewal.js';

const RESOURCES = pathToFileURL(join(import.meta.dirname, '../../index.js')).href;
/** How far the cleanup process's clock runs ahead: the 120 s cutoff then sits 10 s behind real time. */
const AHEAD_MS = 110_000;
/** How long the blocked renewal holds the waiter's thread: past the shifted cutoff, several beats long. */
const BLOCK_MS = 20_000;
/** When the cleanup process sweeps, counted from the start of the block. */
const SWEEP_AFTER_MS = 14_000;
const SHIFT = `data:text/javascript,${encodeURIComponent(`const now = Date.now; Date.now = () => now() + ${AHEAD_MS};`)}`;

/** Block this thread for `ms`, as a synchronous SQLite busy wait does. */
function blockThread(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A fresh machine home for the slot database, restored afterwards. */
function machineHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pb-lease-busy-')));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

/** Run queue cleanup in another process with its clock ahead, after `delayMs`: one take and release of another resource. */
function sweepLater(home, delayMs) {
  const script = `import { takeResource } from ${JSON.stringify(RESOURCES)};
await new Promise(resolve => setTimeout(resolve, ${delayMs}));
const lease = await takeResource({ name: 'sweep', capacity: 1, scope: 'machine', agent: 'sweeper', repo: ${JSON.stringify(home)} });
lease.release();`;
  return runFixtureChildAsync(process.execPath, ['--import', SHIFT, '--input-type=module', '-e', script],
    { env: { ...process.env, PULLBOARD_MACHINE_HOME: home }, encoding: 'utf8' });
}

/** The waiter rows for one agent. */
function waiters(home, agent) {
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare('SELECT ticket, heartbeat FROM waiter WHERE agent = ?').all(agent); }
  finally { db.close(); }
}

test('clause 1: a queued gate keeps its queue entry and item lease while its renewal is blocked past the cleanup cutoff, with no RESOURCE_LEASE_LOST [C7]', async (t) => {
  const home = machineHome(t);
  const held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'holder-a', repo: home });
  let sweep = null, before = null, after = null, renewals = 0;
  const leaseUntil = () => new Date(Date.now() + 3_600_000).toISOString();
  /** The first renewal blocks across a cleanup; the next records the entry and frees the slot. */
  const onWait = async (state) => {
    if (state.admitted) return { leaseUntil: leaseUntil() };
    renewals += 1;
    if (!sweep) {
      before = waiters(home, 'waiter-b');
      sweep = sweepLater(home, SWEEP_AFTER_MS);
      blockThread(BLOCK_MS);
    } else if (!after) {
      after = waiters(home, 'waiter-b');
      held.release();
    }
    return { leaseUntil: leaseUntil() };
  };
  const admitted = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'waiter-b', repo: home, onWait });
  const swept = await sweep;
  assert.equal(swept.status, 0, swept.stderr);
  assert.equal(before.length, 1, 'the gate was queued before its renewal blocked');
  assert.deepEqual(after.map(row => row.ticket), [before[0].ticket], 'the entry kept its place through the cleanup');
  assert.ok(renewals >= 2, 'the item lease renewed again after the blocked renewal');
  assert.equal(admitted.name, 'gate', 'the gate was admitted once the slot freed, with no RESOURCE_LEASE_LOST');
  admitted.release();
});

test('clause 2: a queued gate whose process is gone is still cleaned up, though its renewal thread was beating [C7]', async (t) => {
  let held;
  t.after(() => held?.release());
  const home = machineHome(t);
  held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'holder-a', repo: home });
  // The child queues behind the held slot and blocks in its renewal, so its beat thread is running when it dies.
  const script = `import { takeResource } from ${JSON.stringify(RESOURCES)};
await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'dead-gate', repo: ${JSON.stringify(home)},
  onWait: async () => { process.stdout.write('blocking\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000); } });`;
  const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, PULLBOARD_MACHINE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('blocking\n')) resolve(); });
    child.once('exit', (code) => reject(new Error(`the queued child exited ${code} before blocking`)));
  });
  assert.equal(waiters(home, 'dead-gate').length, 1, 'the child is queued');
  child.kill('SIGKILL');
  await once(child, 'exit');
  // Any queue update sweeps: one take and release of another resource.
  const lease = await takeResource({ name: 'sweep', capacity: 1, scope: 'machine', agent: 'sweeper', repo: home });
  lease.release();
  assert.deepEqual(waiters(home, 'dead-gate'), [], 'the dead gate left the queue');
});

test('clause 1: a renewal that begins as the cached beat thread retires after its idle timeout still advances the queued waiter heartbeat [C7]', async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pb-lease-retire-')));
  const file = join(home, 'resources.sqlite');
  const db = new DatabaseSync(file);
  t.after(() => { tuneRenewalBeat(); try { db.close(); } catch { /* Already closed. */ } rmSync(home, { recursive: true, force: true }); });
  db.exec('CREATE TABLE waiter (token TEXT PRIMARY KEY, heartbeat INTEGER NOT NULL)');
  db.prepare('INSERT INTO waiter (token, heartbeat) VALUES (?, 0)').run('retire-token');
  const heartbeat = () => db.prepare('SELECT heartbeat FROM waiter WHERE token = ?').get('retire-token').heartbeat;
  tuneRenewalBeat({ beatMs: 100, idleMs: 300 });
  await renewWithBeat(file, 'retire-token', true, () => 'first');
  // Hold this thread past the idle timeout: the cached thread retires and exits, but its exit event cannot be handled yet.
  blockThread(1_000);
  const start = Date.now();
  db.prepare('UPDATE waiter SET heartbeat = 0 WHERE token = ?').run('retire-token');
  await renewWithBeat(file, 'retire-token', true, () => { blockThread(1_000); return 'second'; });
  assert.ok(heartbeat() >= start, 'a fresh beat thread advanced the heartbeat during the renewal that began at retirement');
});
