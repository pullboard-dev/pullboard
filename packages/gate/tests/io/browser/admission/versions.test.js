import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { describe } from 'node:test';
import { takeResource } from '../../../../../resources/index.js';
import { PRE_RUNNER_MODULE } from '../../../fixtures/admission/pool.js';
import { acquired } from '../../../fixtures/admission/pool.js';
import { delay } from '../../../fixtures/admission/pool.js';
import { event } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { poolWorker } from '../../../fixtures/admission/pool.js';
import { privateList } from '../../../fixtures/admission/pool.js';
import { release } from '../../../fixtures/admission/pool.js';
import { setQueueOrder } from '../../../fixtures/admission/pool.js';
import { waitUntil } from '../../../fixtures/admission/pool.js';
import { worker } from '../../../fixtures/admission/pool.js';
/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
describe('isolated mixed-version and release queues [C7,Q1,Q2]', { concurrency: 4 }, () => {
test('gate.io-browser-admission-versions.a-line-holding-an-older-pullboard: a line holding an older pullboard waiter keeps arrival order, so mixed versions never deadlock [C7]', async () => {
  const box = fixture();
  setQueueOrder(box, { reviewsFirst: true }); // #697: class order is a machine opt-in.
  const holders = [poolWorker(box, { agent: 'mixed-holder-one' }), poolWorker(box, { agent: 'mixed-holder-two' })];
  for (const holder of holders) await acquired(holder);
  // A real older pullboard (before #651) writes no class marker; it admits landings first and then by ticket.
  const older = poolWorker(box, { agent: 'older-focused', kind: 'focused', module: PRE_RUNNER_MODULE });
  await event(older);
  const review = poolWorker(box, { agent: 'newer-review', kind: 'review', item: '651' });
  assert.equal((await event(review)).queued.position, 2, 'the review waits behind the older waiter\'s earlier ticket');
  const gate = () => privateList(box).find(({ name }) => name === 'gate');
  assert.equal(gate().order, 'arrival');
  assert.deepEqual(gate().line.map(({ agent }) => agent), ['older-focused', 'newer-review']);

  await release(holders[0]);
  assert.equal((await acquired(older)).acquired, 'older-focused', 'both versions agree the earlier ticket goes first');
  assert.equal(gate().order, undefined, 'class order resumes once only marked waiters remain');
  await release(holders[1]);
  assert.equal((await acquired(review)).acquired, 'newer-review');
  await release(older);
  await release(review);
});


});


test('gate.io-browser-admission-versions.q1-q2-a-waiting-landing-keeps: [Q1,Q2] a waiting landing keeps a current holder from taking the second slot [Q1,Q2]', async () => {
  const box = fixture();
  const firstHolder = worker(box, { capacity: 2, agent: 'same-run' });
  const secondHolder = worker(box, { capacity: 2, agent: 'other-run' });
  assert.equal((await acquired(firstHolder)).acquired, 'same-run');
  assert.equal((await acquired(secondHolder)).acquired, 'other-run');
  const landing = worker(box, { capacity: 2, agent: 'landing', landing: true });
  assert.equal((await event(landing)).waiting, 1);
  const secondSlot = worker(box, { capacity: 2, agent: 'same-run' });
  assert.equal((await event(secondSlot)).waiting, 2);
  assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [['landing', true], ['same-run', false]]);

  await release(secondHolder);
  assert.equal((await event(landing)).acquired, 'landing');
  await assert.rejects(event(secondSlot, 250), /worker timed out/u, 'the holder cannot take its second slot ahead of a waiting landing'); // budget: declared negative observation window while an explicitly held landing blocks this waiter.
  await release(landing);
  assert.equal((await event(secondSlot)).acquired, 'same-run');
  await release(secondSlot);
  await release(firstHolder);
});

test('gate.io-browser-admission-versions.q1-q2-a-holder-cannot-queue: [Q1,Q2] a holder cannot queue a landing second slot ahead of another landing [Q1,Q2]', async () => {
  const box = fixture();
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  let first;
  let second;
  let other;
  let landing;
  let extraLease;
  let extraPromise;
  try {
    first = await takeResource({ name: 'gate', capacity: 2, root: box.first, agent: 'same-run' });
    other = worker(box, { capacity: 2, agent: 'other-run' });
    assert.equal((await acquired(other)).acquired, 'other-run');
    extraPromise = takeResource({ name: 'gate', capacity: 2, root: box.second, agent: 'second-label', landing: true })
      .then((lease) => { extraLease = lease; return lease; });
    await waitUntil(() => privateList(box)[0].line.some(({ agent, landing: isLanding }) => agent === 'second-label' && isLanding), 'the same process second slot to queue');

    landing = worker(box, { capacity: 2, agent: 'next-landing', landing: true });
    assert.equal((await event(landing)).waiting, 1, 'the later landing is the first eligible landing');
    assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [
      ['second-label', true], ['next-landing', true],
    ]);

    await release(other);
    other = null;
    assert.equal((await event(landing)).acquired, 'next-landing', 'a current holder cannot take a second slot ahead of a different landing run');
    const holderAgents = privateList(box)[0].holders.map(({ agent }) => agent).sort();
    assert.deepEqual(holderAgents, ['next-landing', 'same-run']);
    await release(landing);
    landing = null;
    second = await extraPromise;
    assert.deepEqual(privateList(box)[0].holders.map(({ agent }) => agent), ['same-run', 'second-label']);
  } finally {
    if (other && !other.exitResult) await release(other);
    if (landing && !landing.exitResult) {
      first?.release();
      extraLease?.release();
      try { await acquired(landing); } catch { /* Preserve the assertion that led to cleanup. */ }
      if (!landing.exitResult) await release(landing);
    }
    first?.release();
    second?.release();
    extraLease?.release();
    if (extraPromise && !extraLease) {
      await Promise.race([extraPromise.then((lease) => lease.release()), delay(500)]);
    }
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

/** A capacity-three queue must not grant an empty slot to holders queued for their own second slot. */
test('gate.io-browser-admission-versions.q1-q2-landing-holders-leave-an: [Q1,Q2] landing holders leave an empty slot for the next eligible landing [Q1,Q2]', async () => {
  const box = fixture();
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  let firstA;
  let secondA;
  let holderB;
  let holderC;
  let secondAPromise;
  let secondAAcquired = false;
  try {
    firstA = await takeResource({ name: 'gate', capacity: 3, root: box.first, agent: 'holder-a' });
    holderB = worker(box, { capacity: 3, agent: 'holder-b' });
    holderC = worker(box, { capacity: 3, agent: 'holder-c' });
    assert.equal((await acquired(holderB)).acquired, 'holder-b');
    assert.equal((await acquired(holderC)).acquired, 'holder-c');

    secondAPromise = takeResource({ name: 'gate', capacity: 3, root: box.first, agent: 'holder-a', landing: true })
      .then((lease) => { secondAAcquired = true; secondA = lease; return lease; });
    await waitUntil(() => privateList(box)[0].line.some(({ agent, landing }) => agent === 'holder-a' && landing), 'holder A second landing to queue');
    holderB.stdin.write('second\n');
    await waitUntil(() => privateList(box)[0].line.filter(({ landing }) => landing).length === 2, 'holder B second landing to join');

    await release(holderC);
    holderC = null;
    await delay(300);
    assert.deepEqual(privateList(box)[0].holders.map(({ agent }) => agent).sort(), ['holder-a', 'holder-b'], 'neither holder takes the free third slot while the other holder landing waits');
    assert.equal(secondAAcquired, false, 'A second slot remains queued');
    assert.deepEqual(holderB.pendingLines.filter((line) => line.includes('secondAcquired')), [], 'B second slot remains queued');

    firstA.release();
    firstA = null;
    await secondAPromise;
    assert.ok(secondAAcquired, 'releasing A first makes its landing the next eligible landing');
    assert.equal((await event(holderB)).secondAcquired, 'holder-b', 'B can finish after A no longer waits');
    holderB.stdin.end('release\n');
    assert.equal((await holderB.finished).code, 0, holderB.errors);
    holderB.lines.close();
    holderB = null;
    secondA.release();
    secondA = null;
  } finally {
    for (const child of [holderB, holderC]) if (child && !child.exitResult) child.kill('SIGKILL');
    await Promise.all([holderB, holderC].filter(Boolean).map((child) => child.finished));
    for (const child of [holderB, holderC]) child?.lines.close();
    firstA?.release();
    secondA?.release();
    privateList(box); // Purge any dead child holder/waiter rows before dropping the private database.
    if (secondAPromise && !secondA) {
      await secondAPromise;
    }
    secondA?.release();
    privateList(box);
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});
