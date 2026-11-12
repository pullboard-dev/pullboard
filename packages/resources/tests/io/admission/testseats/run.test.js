/** A pullboard test run reaches a free runner slot within 60 s even while gate runs keep the queue busy [C7,#3431]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeResource } from '../../../../index.js';
import { privateFixtureFiles } from '../../../../../../apps/cli/tests/fixtures/child.js';

const POLL_TICK_MS = 5_000;
const PROMISE_MS = 60_000;

/** Isolate the machine resource SQLite database and freeze Date so each queue poll advances a simulated clock. */
function fixture(t) {
  const { root } = privateFixtureFiles('pullboard-test-admission-');
  const home = join(root, 'machine');
  mkdirSync(home);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T09:00:00.000Z') });
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Runner-only gate options over fake runners; nothing is dispatched, the lease alone is the admission. */
function pool(root, runners) {
  return { name: 'gate', scope: 'machine', root, capacity: 0, remote: true, runnerOnly: true, runnerWaitMs: 3_600_000, runnerProvider: () => runners };
}

/**
 * Queue a gate waiter that stays in line until `stop.done`, then leaves without a slot; `onQueued` sees each poll.
 * Resolves to 'left' when it left the line, or to the lease when it was admitted first.
 */
function queued(options, stop, onQueued = () => {}) {
  const left = new Error('fixture waiter left the line');
  return takeResource({ ...options, onWait: () => { if (stop.done) throw left; onQueued(); } })
    .then(lease => lease, error => { if (error !== left) throw error; return 'left'; });
}

test('clause 1: a test run is admitted within 60 s when a runner has a free slot [C7]', async t => {
  const root = fixture(t);
  const runners = [{ host: 'busy-runner', slots: 1, browser: 0 }, { host: 'free-runner', slots: 2, browser: 0 }];
  const base = pool(root, runners);
  const held = [await takeResource({ ...base, agent: 'gate-a', kind: 'gate', requiredExecutor: { kind: 'ssh', host: 'busy-runner' } })];
  held.push(await takeResource({ ...base, agent: 'gate-b', kind: 'gate', requiredExecutor: { kind: 'ssh', host: 'free-runner' } }));
  assert.deepEqual(held.map(lease => lease.runner.host), ['busy-runner', 'free-runner']);
  const stop = { done: false };
  const gateWaits = [];
  try {
    // Gate runs wait for the busy runner while free-runner shows one free gate slot; each first poll proves it is in line.
    for (const agent of ['gate-c', 'gate-d']) {
      let inLine;
      const polled = new Promise(resolvePromise => { inLine = resolvePromise; });
      gateWaits.push(queued({ ...base, agent, kind: 'gate', requiredExecutor: { kind: 'ssh', host: 'busy-runner' } }, stop, () => inLine()));
      await polled;
    }
    let waitedMs = 0;
    const lease = await takeResource({ ...base, agent: 'seat-a', kind: 'test', onWait: () => {
      assert.ok(waitedMs < PROMISE_MS, 'the test run waited 60 s of simulated time while free-runner had a free slot');
      waitedMs += POLL_TICK_MS;
      t.mock.timers.tick(POLL_TICK_MS);
    } });
    try {
      assert.equal(lease.runner.host, 'free-runner');
      assert.ok(waitedMs <= PROMISE_MS, `admitted after ${waitedMs} ms of simulated time`);
      // The gate leases kept their slots: the test took only the free one.
      for (const gate of held) gate.renew();
    } finally { lease.release(); }
  } finally {
    stop.done = true;
    for (const gate of held) gate.release();
    // A waiter that won busy-runner as the holders left releases it; none may have taken free-runner's slot.
    for (const result of await Promise.all(gateWaits)) if (result !== 'left') { assert.equal(result.runner.host, 'busy-runner'); result.release(); }
  }
});

test('clause 2: test runs and gate runs share free slots fairly [C7]', async t => {
  const root = fixture(t);
  const runner = { host: 'fixture-runner', slots: 2, browser: 0 };
  const base = pool(root, [runner]);
  const steady = await takeResource({ ...base, agent: 'gate-steady', kind: 'gate' });
  const stop = { done: false };
  let streamLease = await takeResource({ ...base, agent: 'gate-stream', kind: 'gate' });
  let streamWait = null;
  let active = 2;
  /** One more gate run of the steady stream: it finishes, and the next arrives and queues for the slot it freed. */
  const nextGate = () => {
    streamLease.release();
    streamLease = null;
    active -= 1;
    streamWait = queued({ ...base, agent: 'gate-stream', kind: 'gate' }, stop)
      .then(lease => { if (lease === 'left') return; if (stop.done) { lease.release(); return; } streamLease = lease; active += 1; });
  };
  let polls = 0;
  try {
    const lease = await takeResource({ ...base, agent: 'seat-a', kind: 'test', onWait: () => {
      assert.ok(polls * POLL_TICK_MS < PROMISE_MS, 'a steady stream of gate runs starved the waiting test run for 60 s of simulated time');
      polls += 1;
      t.mock.timers.tick(POLL_TICK_MS);
      // Each poll the stream's admitted gate finishes and a fresh gate run queues behind the test for the freed slot.
      if (streamLease) nextGate();
    } });
    try {
      assert.equal(lease.runner.host, 'fixture-runner');
      assert.ok(polls >= 2, 'the stream kept every slot busy before the test ranked first');
      assert.ok(active + 1 <= runner.slots, `the test run took a slot a gate held (${active} gate lease(s) on ${runner.slots} slots)`);
      steady.renew();
      streamLease?.renew();
    } finally { lease.release(); }
  } finally {
    stop.done = true;
    await streamWait;
    steady.release();
    streamLease?.release();
  }
});
