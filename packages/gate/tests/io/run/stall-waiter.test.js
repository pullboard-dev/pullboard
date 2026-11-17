/** A machine-queue waiter whose slot was freed with no wake-up re-checks on a bounded interval and takes the slot [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { takeResource } from '../../../../resources/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

/** The most a waiter may take to notice a freed slot: far above the poll, far below any lease expiry. */
const BOUND_MS = 3_000;

test('gate.io-run-stall-waiter.a-waiter-whose-slot-was-freed: clause 1: a waiter whose slot was freed without a wake-up takes it on its own re-check within a bounded interval [C7]', async t => {
  const home = privateFixtureFiles('pullboard-stall-waiter-').root;
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const holder = await takeResource({ name: 'stall-waiter-fixture', capacity: 1, agent: 'fixture-holder' });
  let queued;
  const isQueued = new Promise(resolve => { queued = resolve; });
  const waiting = takeResource({ name: 'stall-waiter-fixture', capacity: 1, agent: 'fixture-waiter', onWait: state => { if (state.position >= 1) queued(); } });
  await isQueued; // the waiter is in line behind the holder
  holder.release(); // freed with nothing told to the waiter: it can only find the slot by looking again
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`the waiter did not see the freed slot within ${BOUND_MS} ms`)), BOUND_MS); });
  const lease = await Promise.race([waiting, late]).finally(() => clearTimeout(timer));
  lease.release();
  assert.ok(lease, 'the waiter holds the slot it found by re-checking');
});
