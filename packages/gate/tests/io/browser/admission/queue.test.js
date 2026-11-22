import assert from 'node:assert/strict';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { acquired } from '../../../fixtures/admission/pool.js';
import { event } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { poolWorker } from '../../../fixtures/admission/pool.js';
import { privateList } from '../../../fixtures/admission/pool.js';
import { release } from '../../../fixtures/admission/pool.js';
import { requeuedRemoteRun } from '../../../fixtures/admission/pool.js';
import { setQueueOrder } from '../../../fixtures/admission/pool.js';
import { waitUntil } from '../../../fixtures/admission/pool.js';
import { worker } from '../../../fixtures/admission/pool.js';
/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
// These cases keep all asynchronous state in separate child processes and private machine homes.
// Their only parent environment changes are synchronous reads restored before yielding.
describe('isolated resource queue scenarios [C7,Q1,Q2]', { concurrency: 4 }, () => {
test('gate.io-browser-admission-queue.q1-q2-capacity-one-takers-acquire: [Q1,Q2] capacity-one takers acquire in strict FIFO arrival order', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiting = [];
  let firstQueuedAt = 0;
  for (const agent of ['first', 'second', 'third']) {
    const child = worker(box, { agent });
    waiting.push(child);
    const state = await event(child);
    assert.equal(state.waiting, waiting.length, `${agent} reports its FIFO place`);
    assert.equal(state.holders[0].agent, 'holder', `${agent} says who holds the place`);
    if (agent === 'first') {
      assert.equal(state.holders[0].repo, realpathSync(box.first), 'machine-scope listings still identify the Git root');
      firstQueuedAt = Date.parse(state.line[0].since);
      assert.ok(Number.isFinite(firstQueuedAt));
    }
  }
  const order = [];
  let current = holder;
  for (const [index, child] of waiting.entries()) {
    await release(current);
    assert.equal((await event(child)).acquired, ['first', 'second', 'third'][index]);
    if (index === 0) {
      const displayed = privateList(box).find((resource) => resource.name === 'gate').holders[0];
      assert.ok(Date.parse(displayed.since) > firstQueuedAt, 'holder since is when capacity was acquired, not when it joined the queue');
    }
    order.push(['first', 'second', 'third'][index]);
    current = child;
  }
  await release(current);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('gate.io-browser-admission-queue.q1-q2-landing-waiters-jump-ordinary: [Q1,Q2] landing waiters jump ordinary gates but keep FIFO within each class [Q1,Q2]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const ordinaryFirst = worker(box, { agent: 'ordinary-first' });
  assert.equal((await event(ordinaryFirst)).waiting, 1);
  const landingFirst = worker(box, { agent: 'landing-first', landing: true });
  assert.equal((await event(landingFirst)).waiting, 1);
  const ordinarySecond = worker(box, { agent: 'ordinary-second' });
  assert.equal((await event(ordinarySecond)).waiting, 3);
  const landingSecond = worker(box, { agent: 'landing-second', landing: true });
  assert.equal((await event(landingSecond)).waiting, 2);
  const listed = privateList(box)[0].line;
  assert.deepEqual(listed.map(({ agent, landing }) => [agent, landing]), [
    ['landing-first', true], ['landing-second', true], ['ordinary-first', false], ['ordinary-second', false],
  ]);

  await release(holder);
  assert.equal((await event(landingFirst)).acquired, 'landing-first');
  await release(landingFirst);
  assert.equal((await event(landingSecond)).acquired, 'landing-second');
  await release(landingSecond);
  assert.equal((await event(ordinaryFirst)).acquired, 'ordinary-first');
  await release(ordinaryFirst);
  assert.equal((await event(ordinarySecond)).acquired, 'ordinary-second');
  await release(ordinarySecond);
});

test('gate.io-browser-admission-queue.the-pool-alone-orders-submits-reviews: the pool alone orders submits, reviews and browser runs [C7]', async () => {
  const orderBox = fixture();
  const orderHolder = poolWorker(orderBox, { agent: 'order-holder' });
  const otherHolder = poolWorker(orderBox, { agent: 'other-holder' });
  assert.equal((await acquired(orderHolder)).acquired, 'order-holder');
  assert.equal((await acquired(otherHolder)).acquired, 'other-holder');

  const olderReview = poolWorker(orderBox, { agent: 'older-review', browser: true, item: '620', kind: 'review' });
  assert.equal((await event(olderReview)).queued.position, 1);
  const laterFocused = poolWorker(orderBox, { agent: 'later-focused', kind: 'focused' });
  assert.ok((await event(laterFocused)).queued, 'later focused work has joined behind the review');

  await release(orderHolder);
  await waitUntil(() => privateList(orderBox).find(({ name }) => name === 'gate').holders
    .some(({ agent }) => agent === 'older-review' || agent === 'later-focused'), 'the first eligible waiter to acquire');
  let orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.ok(orderedGate.holders.some(({ agent, itemCheck, item }) =>
    agent === 'older-review' && itemCheck && item === '620'),
  'an older eligible review stays ahead of later focused work');
  assert.ok(!orderedGate.holders.some(({ agent }) => agent === 'later-focused'),
    'later focused work cannot jump the older review');
  assert.equal((await acquired(olderReview)).acquired, 'older-review');

  const diagnosticOne = poolWorker(orderBox, { agent: 'diagnostic-one', kind: 'diagnostic' });
  assert.equal((await event(diagnosticOne)).queued.position, 1, 'a diagnostic goes ahead of the waiting focused run');
  const laterReview = poolWorker(orderBox, { agent: 'later-review', item: '621', kind: 'review' });
  assert.equal((await event(laterReview)).queued.position, 3);
  const diagnosticTwo = poolWorker(orderBox, { agent: 'diagnostic-two', kind: 'diagnostic' });
  assert.equal((await event(diagnosticTwo)).queued.position, 2, 'a diagnostic queues behind the earlier diagnostic');
  const laterGate = poolWorker(orderBox, { agent: 'later-gate', kind: 'focused' });
  assert.equal((await event(laterGate)).queued.position, 5);
  const laterLanding = poolWorker(orderBox, { agent: 'later-landing', landing: true });
  await event(laterLanding);
  orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.deepEqual(orderedGate.line.map(({ agent, landing, diagnostic, itemCheck, kind }) =>
    [agent, landing, diagnostic === true, itemCheck, kind ?? '']), [
    ['later-landing', true, false, false, ''],
    ['diagnostic-one', false, true, false, 'diagnostic'],
    ['diagnostic-two', false, true, false, 'diagnostic'],
    ['later-focused', false, false, false, 'focused'],
    ['later-review', false, false, true, 'review'],
    ['later-gate', false, false, false, 'focused'],
  ], 'landing, then diagnostics, then every other kind in arrival order');

  await release(otherHolder);
  assert.equal((await acquired(laterLanding)).acquired, 'later-landing',
    'a later landing jumps the older focused and diagnostic waiters');
  orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.ok(orderedGate.holders.some(({ agent, landing }) => agent === 'later-landing' && landing));

  await release(laterLanding);
  assert.equal((await acquired(diagnosticOne)).acquired, 'diagnostic-one',
    'diagnostics pass the older focused run once every waiter knows the ordering');
  await release(diagnosticOne);
  assert.equal((await acquired(diagnosticTwo)).acquired, 'diagnostic-two', 'diagnostics keep their FIFO place among themselves');
  await release(diagnosticTwo);
  assert.equal((await acquired(laterFocused)).acquired, 'later-focused', 'the oldest other waiter follows the diagnostics');
  await release(laterFocused);
  assert.equal((await acquired(laterReview)).acquired, 'later-review');
  await release(laterReview);
  assert.equal((await acquired(laterGate)).acquired, 'later-gate');
  await release(laterGate);
  await release(olderReview);

  const box = fixture();
  const firstHolder = poolWorker(box, { agent: 'submit-one' });
  const secondHolder = poolWorker(box, { agent: 'submit-two' });
  assert.equal((await acquired(firstHolder)).acquired, 'submit-one');
  assert.equal((await acquired(secondHolder)).acquired, 'submit-two');

  const firstReview = poolWorker(box, { agent: 'review-one', browser: true, item: '618', kind: 'review' });
  const firstQueued = await event(firstReview);
  assert.equal(firstQueued.queued.position, 1, 'a review waits while both submit slots are occupied');
  let browser = privateList(box).find(({ name }) => name === 'browser');
  assert.ok(browser, 'the pool must expose browser capacity and its waiting review');
  assert.equal(browser.capacity, 1, 'the browser pool has its fixed single slot');
  assert.deepEqual(browser.line.map(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    [agent, ownsBrowser, itemCheck, item, kind]), [['review-one', true, true, '618', 'review']]);

  // Releasing one holder is the only signal; the oldest eligible review acquires on its own poll.
  await release(firstHolder);
  assert.equal((await acquired(firstReview)).acquired, 'review-one');
  let gate = privateList(box).find(({ name }) => name === 'gate');
  assert.ok(gate.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-one' && ownsBrowser && itemCheck && item === '618' && kind === 'review'));

  const secondReview = poolWorker(box, { agent: 'review-two', browser: true, item: '619', kind: 'review' });
  const secondQueued = await event(secondReview);
  assert.equal(secondQueued.queued.position, 1, 'the browser waiter reports its actual queue position');
  const thirdSubmit = poolWorker(box, { agent: 'submit-three' });
  const submitQueued = await event(thirdSubmit);
  assert.equal(submitQueued.queued.position, 2,
    'the visible queue preserves FIFO position behind its earlier browser waiter');
  browser = privateList(box).find(({ name }) => name === 'browser');
  assert.deepEqual(browser.line.map(({ agent, itemCheck, item, kind }) => [agent, itemCheck, item, kind]), [
    ['review-two', true, '619', 'review'],
  ], 'the active browser review is listed as a holder, not as a waiter');
  assert.ok(browser.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-one' && ownsBrowser && itemCheck && item === '618' && kind === 'review'));

  // A free gate slot appears while the browser slot remains held; the queued submit proceeds.
  await release(secondHolder);
  assert.equal((await acquired(thirdSubmit)).acquired, 'submit-three');
  assert.ok(privateList(box).find(({ name }) => name === 'browser').line
    .some(({ agent }) => agent === 'review-two'), 'the second review stays queued while the browser slot is occupied');

  // Releasing both older leases lets the oldest eligible browser waiter proceed without a message.
  await release(thirdSubmit);
  await release(firstReview);
  assert.equal((await acquired(secondReview)).acquired, 'review-two');
  gate = privateList(box).find(({ name }) => name === 'gate');
  assert.ok(gate.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-two' && ownsBrowser && itemCheck && item === '619' && kind === 'review'));
  await release(secondReview);
});

});

test('gate.io-browser-admission-queue.the-pool-admits-reviews-before-submits: the pool admits reviews before submits before focused runs, and waiting runs age up [C7,V4]', async () => {
  const AGE_MS = 30 * 60_000;
  const box = fixture();
  setQueueOrder(box, { reviewsFirst: true }); // #697: class order is a machine opt-in.
  const holders = [poolWorker(box, { agent: 'holder-one' }), poolWorker(box, { agent: 'holder-two' })];
  for (const holder of holders) await acquired(holder);
  const waiting = new Map();
  const positions = {};
  for (const [agent, options] of [
    ['focused-one', { kind: 'focused' }],
    ['diagnostic-one', { kind: 'diagnostic' }],
    ['submit-one', { kind: 'submit', item: '650' }],
    ['review-one', { kind: 'review', item: '651' }],
    ['landing-one', { landing: true }],
    ['focused-two', { kind: 'focused' }],
  ]) {
    const child = poolWorker(box, { agent, ...options });
    waiting.set(agent, child);
    positions[agent] = (await event(child)).queued.position;
  }
  assert.deepEqual(positions, { 'focused-one': 1, 'diagnostic-one': 1, 'submit-one': 2, 'review-one': 2, 'landing-one': 1, 'focused-two': 6 },
    'each arrival takes its place by class, with diagnostics ahead of the other waiting runs');
  const line = () => privateList(box).find(({ name }) => name === 'gate').line
    .map(({ agent, queueClass: listed, agedFrom }) => [agent, listed, agedFrom ?? '']);
  assert.deepEqual(line(), [
    ['landing-one', 'landing', ''],
    ['diagnostic-one', 'other', ''],
    ['review-one', 'review', ''],
    ['submit-one', 'submit', ''],
    ['focused-one', 'other', ''],
    ['focused-two', 'other', ''],
  ], 'landing, then diagnostics, then reviews, submits, and focused runs, first come first served within each');

  // Waiting time is the only input to aging; backdating the queued time stands in for the clock.
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  // The pool's own processes write this file too; wait for their lock instead of failing.
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const backdate = db.prepare('UPDATE waiter SET since = ? WHERE agent = ?');
    backdate.run(new Date(Date.now() - 2 * AGE_MS - 60_000).toISOString(), 'focused-two');
    backdate.run(new Date(Date.now() - AGE_MS - 60_000).toISOString(), 'diagnostic-one');
  } finally { db.close(); }
  assert.deepEqual(line(), [
    ['landing-one', 'landing', ''],
    ['diagnostic-one', 'submit', 'other'],
    ['review-one', 'review', ''],
    ['focused-two', 'review', 'other'],
    ['submit-one', 'submit', ''],
    ['focused-one', 'other', ''],
  ], 'a run waiting an hour ranks with reviews and one waiting half an hour with submits, keeping its arrival place there');

  const order = [];
  let releasing = [...holders];
  for (const agent of ['landing-one', 'diagnostic-one', 'review-one', 'focused-two', 'submit-one', 'focused-one']) {
    await release(releasing.shift());
    const child = waiting.get(agent);
    assert.equal((await acquired(child)).acquired, agent, `${agent} is admitted next`);
    order.push(agent);
    releasing.push(child);
  }
  for (const child of releasing) await release(child);
  assert.deepEqual(order, ['landing-one', 'diagnostic-one', 'review-one', 'focused-two', 'submit-one', 'focused-one']);

  // A remote run whose runner drops is requeued with its original arrival ticket: it sits behind
  // earlier runs of its own class and behind waiting reviews and submits, and the line stays in
  // class order (the requeue is marked classed, so it never forces arrival).
  const requeued = await requeuedRemoteRun({ reviewsFirst: true });
  assert.equal(requeued.order, undefined, 'a requeued remote waiter is marked as class-ordered, so the pool keeps class order');
  assert.deepEqual(requeued.line, [
    ['review-later', 'review'], ['submit-later', 'submit'], ['focused-early', 'other'], ['remote-focused', 'other'],
  ], 'the requeued remote run keeps first come, first served in its class, behind the earlier focused run');
  assert.equal(requeued.tickets['remote-focused'], requeued.lastIssued, 'the requeued runner waiter keeps its original ticket, the last one issued');
  assert.ok(requeued.tickets['focused-early'] < requeued.tickets['remote-focused'], 'an earlier same-class waiter keeps its earlier ticket');
  assert.deepEqual(requeued.admitted, ['review-later', 'submit-later', 'focused-early', 'remote-focused']);

  // The class rule itself, against an injected clock rather than real waiting.
  const { QUEUE_AGE_MS, queueClass } = await import('../../../../../resources/index.js');
  const queuedAt = Date.parse('2026-10-15T19:37:00.000Z');
  const at = (minutes) => queuedAt + minutes * 60_000;
  const since = new Date(queuedAt).toISOString();
  assert.equal(QUEUE_AGE_MS, 30 * 60_000, 'a waiter moves up one class every 30 minutes');
  assert.deepEqual([0, 29, 30, 60, 90, 300].map((minutes) => queueClass({ kind: 'focused', since }, at(minutes)).name),
    ['other', 'other', 'submit', 'review', 'landing', 'landing'], 'a focused run ages up one class per 30 minutes waited');
  assert.equal(queueClass({ kind: 'review', since }, at(30)).name, 'landing');
  assert.equal(queueClass({ kind: 'main-red', diagnostic: 1, itemCheck: 1, since }, at(0)).name, 'other', 'a diagnostic is optional work');
  assert.equal(queueClass({ kind: 'check', itemCheck: 1, since }, at(0)).name, 'submit', 'an item check ranks with submits');
  assert.equal(queueClass({ landing: 1, since }, at(0)).name, 'landing');
});
