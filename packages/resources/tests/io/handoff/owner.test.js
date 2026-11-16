/** A waiter bound to one runner never blocks a later waiter another runner can admit; an unready runner is held out and its waiters re-placed [C7,#3692]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ADMISSION_POLL_FRESH_MS } from '../../../index.js';
import { recoverUnavailableRunners } from '../../../index.js';
import { runnerWaitReasons } from '../../../index.js';
import { takeResource } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

/** Isolate the machine resource SQLite database; `clock` also freezes Date so a poll can advance simulated time. */
function fixture(t, { clock = false } = {}) {
  const { root } = privateFixtureFiles('pullboard-queue-no-head-block-');
  const home = join(root, 'machine');
  mkdirSync(home);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  if (clock) t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T22:50:00.000Z') });
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file: join(home, 'resources.sqlite') };
}

/** Runner-only gate options over a fixture runner pool; nothing is dispatched, the lease alone is the admission. */
function pool(root, runners, extra = {}) {
  return { name: 'gate', scope: 'machine', root, capacity: 0, remote: true, runnerOnly: true, runnerWaitMs: 3_600_000, runnerProvider: () => runners, ...extra };
}

/** Pin a request to exactly one runner, the way a placed shard or a main comparison names its host. */
function pinned(host) { return { requiredExecutor: { kind: 'ssh', host, hosts: [host] } }; }

/** Queue a waiter until `stop.done`; resolves 'left' when it left the line, or its lease when admitted. */
function queued(options, stop, onPoll = () => {}) {
  const left = new Error('fixture waiter left the line');
  return takeResource({ ...options, onWait: async () => { if (stop.done) throw left; await onPoll(); if (stop.done) throw left; } })
    .then(lease => lease, error => { if (error !== left) throw error; return 'left'; });
}

/** Resolve on a waiter's first poll, so the test knows it is in line ahead of the next request. */
function firstPoll() {
  let seen;
  const polled = new Promise(resolvePromise => { seen = resolvePromise; });
  return { polled, onPoll: () => seen() };
}

test('clause 1: an earlier waiter bound to a full runner never delays a later waiter another runner admits [C7]', async t => {
  const { root } = fixture(t);
  const runners = [{ host: 'studio-host', slots: 1, browser: 1 }, { host: 'mini', slots: 2, browser: 2 }];
  const base = pool(root, runners, { browser: true, browserCapacityProvider: () => 0 });
  const held = await takeResource({ ...base, agent: 'studio-gate', ...pinned('studio-host') });
  const stop = { done: false };
  const shards = [];
  try {
    // Earlier shards bound to studio-host, which has no free slot, stand at the head of the line.
    for (const agent of ['shard-1', 'shard-2', 'shard-3']) {
      const { polled, onPoll } = firstPoll();
      shards.push(queued({ ...base, agent, ...pinned('studio-host') }, stop, onPoll));
      await polled;
    }
    let polls = 0;
    const lease = await takeResource({ ...base, agent: 'later-gate', onWait: () => { polls += 1; throw new Error('the later waiter waited behind shards bound to a full runner'); } });
    try {
      assert.equal(lease.runner.host, 'mini', 'the later waiter took the free mini slot');
      assert.equal(polls, 0, 'admitted on its first poll, at once');
    } finally { lease.release(); }
  } finally {
    stop.done = true;
    held.release();
    for (const result of await Promise.all(shards)) if (result !== 'left') { assert.equal(result.runner.host, 'studio-host'); result.release(); }
  }
});

test('clause 1: an earlier waiter that stopped polling never holds a free runner slot from a later waiter [C7]', async t => {
  const { root } = fixture(t, { clock: true });
  const runners = [{ host: 'mini', slots: 1, browser: 0 }];
  const base = pool(root, runners);
  const busy = await takeResource({ ...base, agent: 'running-gate' });
  const stop = { done: false };
  let unhang;
  const hung = new Promise(resolvePromise => { unhang = resolvePromise; });
  const { polled, onPoll } = firstPoll();
  // The earlier waiter polls once while the runner is full, then its process stops polling (its renewal never returns).
  const earlier = queued({ ...base, agent: 'stalled-gate' }, stop, async () => { onPoll(); await hung; });
  await polled;
  busy.release();
  const TICK_MS = 1_000;
  let waitedMs = 0;
  try {
    const lease = await takeResource({ ...base, agent: 'later-gate', onWait: () => {
      assert.ok(waitedMs <= ADMISSION_POLL_FRESH_MS + TICK_MS, `the free slot stayed held for a waiter that is not polling (${waitedMs} ms)`);
      waitedMs += TICK_MS;
      t.mock.timers.tick(TICK_MS);
    } });
    try {
      assert.equal(lease.runner.host, 'mini');
      assert.ok(waitedMs <= ADMISSION_POLL_FRESH_MS + TICK_MS, `admitted ${waitedMs} ms after the earlier waiter stopped polling`);
    } finally { lease.release(); }
  } finally {
    stop.done = true;
    unhang();
    const result = await earlier;
    if (result !== 'left') result.release();
  }
});

test('clause 2: a runner whose worker misses READY is recorded unavailable, held out when it recurs, and its bound waiter is re-placed [C7]', async t => {
  const { root, file } = fixture(t);
  const runners = [{ host: 'studio-host', slots: 1, browser: 0 }, { host: 'mini', slots: 2, browser: 0 }];
  const base = pool(root, runners);
  const stop = { done: false };
  const leases = [];
  try {
    const first = await takeResource({ ...base, agent: 'shard-on-studio-host', ...pinned('studio-host') });
    assert.equal(first.runner.host, 'studio-host');
    const { polled, onPoll } = firstPoll();
    const bound = queued({ ...base, agent: 'bound-shard', ...pinned('studio-host') }, stop, onPoll);
    await polled;
    // The gate's real readiness failure path: the admitted worker missed READY, so the lease requeues worker-unresponsive.
    leases.push(await first.requeueRunner('worker-unresponsive', { quarantine: true, diagnostic: { reason: 'admission-deadline' } }));
    assert.equal(leases[0].runner.host, 'mini', 'the failed shard itself moved to the other runner');
    const db = new DatabaseSync(file);
    t.after(() => db.close());
    assert.equal(db.prepare('SELECT detail FROM runner_unavailable WHERE host=?').get('studio-host').detail, 'WORKER_UNRESPONSIVE');
    const waiter = { browser: 0, gui: 0, timing: 0, token: 'reader' };
    assert.match(runnerWaitReasons(db, runners, waiter, new Set(['studio-host']))[0].reason, /^unreachable \(worker did not become ready\)/u);
    // A waiter bound only to studio-host is re-placed on the runner that can take it, not left waiting for its deadline.
    const replaced = await bound;
    assert.notEqual(replaced, 'left');
    leases.push(replaced);
    assert.equal(replaced.runner.host, 'mini', 'the bound waiter was re-placed on another eligible runner');

    // The real recovery path lifts a first failure on an idle proof, as on 7 Nov.
    const idleProbe = async () => ({ healthy: true, idle: true, writable: true, step: 'idle proof', reason: 'no live runner process and root writable' });
    const probes = { probe: async () => ({ healthy: false, step: 'worker readiness' }), idleProbe };
    assert.equal(await recoverUnavailableRunners(db, runners, probes), true, 'a first readiness failure is probed at once');
    assert.equal(db.prepare('SELECT 1 FROM runner_unavailable WHERE host=?').get('studio-host'), undefined);
    for (const lease of leases.splice(0)) lease.release();

    // The worker misses READY again: this time the runner is held out, so the idle proof cannot return it within seconds.
    const again = await takeResource({ ...base, agent: 'next-shard-on-studio-host', ...pinned('studio-host') });
    assert.equal(again.runner.host, 'studio-host');
    leases.push(await again.requeueRunner('worker-unresponsive', { quarantine: true, diagnostic: { reason: 'admission-deadline' } }));
    const row = db.prepare('SELECT detail, probe_after AS probeAfter, failure FROM runner_unavailable WHERE host=?').get('studio-host');
    assert.equal(row.detail, 'WORKER_UNRESPONSIVE');
    assert.ok(row.probeAfter >= Date.now() + 55_000, 'a recurring readiness failure waits a minute before its next probe');
    assert.equal(JSON.parse(row.failure).readinessHold.recurrences, 1);
    assert.equal(await recoverUnavailableRunners(db, runners, probes), false, 'no probe lifts a held runner early');
    assert.match(runnerWaitReasons(db, runners, waiter, new Set(['studio-host']))[0].reason,
      /^unreachable \(worker did not become ready\); readiness: missed READY again after 1 lifted readiness failure/u);
  } finally {
    stop.done = true;
    for (const lease of leases) lease.release();
  }
});

test('clause 2: a waiter bound to an unready runner with no other place ends infrastructure-red within its admission timeout [C7]', async t => {
  const { root } = fixture(t);
  const runners = [{ host: 'studio-host', slots: 1, browser: 0 }, { host: 'mini', slots: 1, browser: 0 }];
  const base = pool(root, runners);
  const leases = [];
  try {
    const failing = await takeResource({ ...base, agent: 'shard-on-studio-host', ...pinned('studio-host') });
    leases.push(await failing.requeueRunner('worker-unresponsive', { quarantine: true, diagnostic: { reason: 'admission-deadline' } }));
    assert.equal(leases[0].runner.host, 'mini', 'mini is now full');
    const WAIT_MS = 1_500;
    const started = Date.now();
    await assert.rejects(takeResource({ ...base, agent: 'bound-shard', runnerWaitMs: WAIT_MS, ...pinned('studio-host'), onWait() {} }),
      error => error.code === 'RUNNER_WAIT_DEADLINE' && /studio-host: unreachable \(worker did not become ready\)/u.test(error.message));
    assert.ok(Date.now() - started < WAIT_MS + 5_000, 'the bound waiter ended within its admission timeout, never waiting without limit');
  } finally { for (const lease of leases) lease.release(); }
});
