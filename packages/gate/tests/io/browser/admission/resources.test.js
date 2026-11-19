/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
import { redGateReleaseSource } from '../../../fixtures/execution.js';
import { awaitNestedRun } from '../../../../src/io/test/file/pool.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../../fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../../fixtures/child.js';
import { runFixtureChildAsync } from '../../../fixtures/child.js';
import { once } from 'node:events';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after } from 'node:test';
import { test } from 'node:test';
import { describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setResourceCapacity } from '../../../../../resources/index.js';
import { takeResource } from '../../../../../resources/index.js';
import { checkNeedsBrowser } from '../../../../src/io/browser/admission.js';
import { executionServicesSource } from '../../../fixtures/execution.js';
import { oldSchema } from '../../../fixtures/admission/lease.js';
import { staleIdentity } from '../../../fixtures/admission/lease.js';
import { expireHeartbeat } from '../../../fixtures/admission/lease.js';
import { capacityChangeCases } from '../../../fixtures/resources/capacity.js';
import { releaseQueueProof } from '../../../fixtures/resources/release.js';
import { machineSettings } from '../../../fixtures/admission/settings.js';
import { cpuCheckRepo } from '../../../fixtures/admission/cpu.js';
import { MODULE } from '../../../fixtures/admission/pool.js';
import { POOL_MODULE_WORKER } from '../../../fixtures/admission/pool.js';
import { PERL_FORK } from '../../../fixtures/admission/pool.js';
import { PRE_RUNNER_MODULE } from '../../../fixtures/admission/pool.js';
import { SANDBOX_EXEC } from '../../../fixtures/admission/pool.js';
import { TEST_RUNNER } from '../../../fixtures/admission/pool.js';
import { acquired } from '../../../fixtures/admission/pool.js';
import { delay } from '../../../fixtures/admission/pool.js';
import { event } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { insertExpiredHolder } from '../../../fixtures/admission/pool.js';
import { memoryWorker } from '../../../fixtures/admission/pool.js';
import { poolWorker } from '../../../fixtures/admission/pool.js';
import { privateList } from '../../../fixtures/admission/pool.js';
import { privateTake } from '../../../fixtures/admission/pool.js';
import { release } from '../../../fixtures/admission/pool.js';
import { requeuedRemoteRun } from '../../../fixtures/admission/pool.js';
import { setQueueOrder } from '../../../fixtures/admission/pool.js';
import { waitForMarker } from '../../../fixtures/admission/pool.js';
import { waitForProcessState } from '../../../fixtures/admission/pool.js';
import { waitUntil } from '../../../fixtures/admission/pool.js';
import { worker } from '../../../fixtures/admission/pool.js';
import { writeMemoryReading } from '../../../fixtures/admission/pool.js';
test('gate.io-browser-admission-resources.single-quoted-named-test-checks-skip: single-quoted named-test checks skip the browser slot [C7]', async () => {
  const box = fixture();
  const { repo } = cpuCheckRepo(box);
  const itemCheck = 'node apps/cli/src/io/run/tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  /** Keep assertions about the parser independent of worker custody inherited by the test process. */
  const classify = command => checkNeedsBrowser(repo, command, { env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(await classify(itemCheck), false, 'an explicit CPU-only test file is classifiable');
  const outputPattern = '^[[:space:]]*ok [0-9]+ - item check marker';
  const newlinePrint = ([quote, backslashes]) => `printf ${quote}%s${'\\'.repeat(backslashes)}n${quote} "$out"`;
  const capturedCheck = (formats, patternQuotes) => `out=$(${itemCheck} 2>&1); ${newlinePrint(formats[0])}; ${newlinePrint(formats[1])} | grep -Eq ${patternQuotes[0]}${outputPattern}${patternQuotes[0]} && ${newlinePrint(formats[2])} | grep -Eq ${patternQuotes[1]}^# fail 0$${patternQuotes[1]}`;
  const oneBackslash = [1, 1, 1];
  const accepted = [
    { formats: oneBackslash.map(count => ['\'', count]), patternQuotes: ['\'', '\''] },
    { formats: [['\'', 1], ['"', 1], ['\'', 1]], patternQuotes: ['"', '\''] },
    { formats: [['"', 1], ['\'', 1], ['"', 1]], patternQuotes: ['\'', '"'] },
    { formats: oneBackslash.map(count => ['"', count]), patternQuotes: ['"', '"'] },
  ];
  for (const variant of accepted) {
    assert.equal(await classify(capturedCheck(variant.formats, variant.patternQuotes)), false,
      `the exact capture wrapper accepts quote changes with one literal backslash: ${JSON.stringify(variant)}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const formats = oneBackslash.map(count => ['\'', count]);
    formats[index] = ['\'', 2];
    assert.equal(await classify(capturedCheck(formats, ['\'', '\''])), true,
      `a two-backslash printf at position ${index + 1} stays browser-gated`);
  }
  assert.equal(await classify(`${capturedCheck(accepted[0].formats, accepted[0].patternQuotes)}; :`), true,
    'an arbitrary suffix remains outside the exact capture wrapper');
  const substituted = capturedCheck(accepted[0].formats, accepted[0].patternQuotes)
    .replace('printf \'%s\\n\' "$out"', 'printf \'%s\\n\' "$(printf %s "$out")"');
  assert.equal(await classify(substituted), true, 'a command substitution remains outside the exact printf wrapper');
  assert.equal(await classify('node apps/cli/src/io/run/tests.js test/cockpit/brief.test.js'), true,
    'a named file with no readable declaration stays browser-gated');
  assert.equal(await checkNeedsBrowser(repo, itemCheck, {
    env: { ...process.env, NODE_OPTIONS: '--import=unknown-preload.mjs' },
  }), true, 'an unclassified preload keeps the check browser-gated');
});






/** Prove the machine setting changes real browser admission while retaining the single-slot default [C7]. */
test('gate.io-browser-admission-resources.browserslots-admits-that-many-browser-runs: browserSlots admits that many browser runs and no more [C7]', async () => {
  const defaults = fixture();
  const defaultSettings = machineSettings(defaults, 'loadMachineSettings');
  assert.equal(defaultSettings.error, undefined, defaultSettings.error?.message);
  assert.equal(defaultSettings.value.browserSlots, 1, 'an unset machine keeps the existing single browser slot');

  const box = fixture();
  const configured = machineSettings(box, 'setBrowserSlots', 2);
  assert.equal(configured.error, undefined, configured.error?.message);
  assert.equal(configured.value.browserSlots, 2);
  const readBack = machineSettings(box, 'loadMachineSettings');
  assert.equal(readBack.error, undefined, readBack.error?.message);
  assert.equal(readBack.value.browserSlots, 2, 'the machine setting persists for other processes');
  assert.equal(privateList(box).find(({ name }) => name === 'browser').capacity, 2,
    'the shared browser resource row has the configured capacity before workers start');
  const invalid = machineSettings(box, 'setBrowserSlots', 3);
  assert.ok(invalid.error, 'a browser capacity above the gate capacity is refused');
  assert.equal(invalid.error.code, 'BAD_BROWSER_SLOTS');
  assert.match(invalid.error.message, /pullboard settings gateSlots/u);

  const first = poolWorker(box, { agent: 'browser-one', browser: true });
  assert.equal((await acquired(first)).acquired, 'browser-one');
  const second = poolWorker(box, { agent: 'browser-two', browser: true });
  const secondStart = await event(second);
  if (!secondStart.acquired) {
    const gate = privateList(box).find(({ name }) => name === 'gate');
    const browser = privateList(box).find(({ name }) => name === 'browser');
    assert.fail(`the configured second browser lease queued: ${JSON.stringify({ state: secondStart.queued, gate, browser })}`);
  }
  assert.equal(secondStart.acquired, 'browser-two', 'the configured second browser lease starts while the first is held');
  const third = poolWorker(box, { agent: 'browser-three', browser: true });
  assert.equal((await event(third)).queued.position, 1, 'the next browser run waits for a configured slot');
  const browser = privateList(box).find(({ name }) => name === 'browser');
  assert.equal(browser.capacity, 2, 'resource listing reflects the machine browserSlots setting');
  assert.equal(browser.holders.length, 2);
  assert.deepEqual(browser.holders.map(({ agent }) => agent).sort(), ['browser-one', 'browser-two']);
  assert.deepEqual(browser.line.map(({ agent }) => agent), ['browser-three']);

  await release(first);
  assert.equal((await acquired(third)).acquired, 'browser-three', 'a released browser lease admits the oldest waiting browser run');
  await release(second);
  await release(third);
});

const capacityCases = capacityChangeCases({ machineSettings, fixture, worker, event, acquired, release, privateList, poolWorker, POOL_MODULE_WORKER });

/** Existing queued processes observe a raised limit without restarting their holders [Q1,Q2,Q4]. */
test('gate.io-browser-admission-resources.raising-a-busy-resource-s-capacity: raising a busy resource\'s capacity admits waiters at once [Q1,Q2,Q4]', capacityCases.raising);

/** A refused decrease names the live holders and leaves their leases and settings intact [Q1,Q3,Q4]. */
test('gate.io-browser-admission-resources.lowering-capacity-never-stops-a-running: lowering capacity never stops a running holder [Q1,Q3,Q4]', capacityCases.lowering);

/** Browser capacity can grow under the same live gate lease without exceeding either limit [Q1,Q2,Q4]. */
test('gate.io-browser-admission-resources.raising-busy-browser-capacity-admits-only: raising busy browser capacity admits only the new browser slots [Q1,Q2,Q4]', capacityCases.browser);

test('gate.io-browser-admission-resources.the-gate-pool-serves-the-current: the gate pool serves the current release first [C7,V4]', () => releaseQueueProof({ machineSettings, executionServicesSource, fixture, poolWorker, privateList, event, acquired, release, legacyModule: PRE_RUNNER_MODULE }));


// These cases keep all asynchronous state in separate child processes and private machine homes.
// Their only parent environment changes are synchronous reads restored before yielding.
describe('isolated resource queue scenarios [C7,Q1,Q2]', { concurrency: 4 }, () => {
test('gate.io-browser-admission-resources.q1-q2-capacity-one-takers-acquire: [Q1,Q2] capacity-one takers acquire in strict FIFO arrival order', async () => {
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

test('gate.io-browser-admission-resources.q1-q2-landing-waiters-jump-ordinary: [Q1,Q2] landing waiters jump ordinary gates but keep FIFO within each class [Q1,Q2]', async () => {
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

test('gate.io-browser-admission-resources.the-pool-alone-orders-submits-reviews: the pool alone orders submits, reviews and browser runs [C7]', async () => {
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

test('gate.io-browser-admission-resources.the-pool-admits-reviews-before-submits: the pool admits reviews before submits before focused runs, and waiting runs age up [C7,V4]', async () => {
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

describe('isolated mixed-version and release queues [C7,Q1,Q2]', { concurrency: 4 }, () => {
test('gate.io-browser-admission-resources.a-line-holding-an-older-pullboard: a line holding an older pullboard waiter keeps arrival order, so mixed versions never deadlock [C7]', async () => {
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


test('gate.io-browser-admission-resources.q1-q2-a-waiting-landing-keeps: [Q1,Q2] a waiting landing keeps a current holder from taking the second slot [Q1,Q2]', async () => {
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

test('gate.io-browser-admission-resources.q1-q2-a-holder-cannot-queue: [Q1,Q2] a holder cannot queue a landing second slot ahead of another landing [Q1,Q2]', async () => {
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
test('gate.io-browser-admission-resources.q1-q2-landing-holders-leave-an: [Q1,Q2] landing holders leave an empty slot for the next eligible landing [Q1,Q2]', async () => {
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

// Each process and memory case below also owns a distinct pool; no asynchronous parent environment override is shared.
describe('isolated resource process and memory scenarios [C7,Q1,Q2,Q3]', { concurrency: 4 }, () => {
test('gate.io-browser-admission-resources.q1-q2-landing-priority-preserves-tickets: [Q1,Q2] landing priority preserves tickets while an older resource database migrates [Q1,Q2]', async () => {
  const box = fixture();
  oldSchema(box);
  const oldSince = new Date().toISOString();
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run('gate', 1);
    db.prepare('INSERT INTO holder(token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('old-holder', 'gate', process.pid, 'old-holder', realpathSync(box.first), oldSince, Date.now());
    for (const [ticket, agent] of [[4, 'old-first'], [9, 'old-second']]) {
      db.prepare('INSERT INTO waiter(ticket, token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ticket, `old-${agent}`, 'gate', process.pid, agent, realpathSync(box.first), oldSince, Date.now());
    }
  } finally { db.close(); }

  let retainedLine;
  assert.doesNotThrow(() => { retainedLine = privateList(box)[0].line; }, 'the previous queue schema opens without losing its waiting runs');
  assert.deepEqual(retainedLine.map(({ agent, landing }) => [agent, landing]), [['old-first', false], ['old-second', false]]);
  const migrated = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    assert.deepEqual(migrated.prepare('SELECT ticket, landing FROM waiter ORDER BY ticket').all().map(({ ticket, landing }) => ({ ticket, landing })), [
      { ticket: 4, landing: 0 }, { ticket: 9, landing: 0 },
    ]);
  } finally { migrated.close(); }

  const landing = worker(box, { agent: 'new-landing', landing: true });
  assert.equal((await event(landing)).waiting, 1);
  assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [
    ['new-landing', true], ['old-first', false], ['old-second', false],
  ]);
  const cleanup = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    cleanup.prepare('DELETE FROM waiter WHERE token IN (?, ?)').run('old-old-first', 'old-old-second');
    cleanup.prepare('DELETE FROM holder WHERE token = ?').run('old-holder');
  } finally { cleanup.close(); }
  assert.equal((await event(landing)).acquired, 'new-landing');
  await release(landing);
});

test('gate.io-browser-admission-resources.q1-q2-capacity-two-admits-two: [Q1,Q2] capacity two admits two holders and serves the next waiter', async () => {
  const box = fixture();
  const first = worker(box, { name: 'two-slots', capacity: 2, agent: 'first-holder' });
  const second = worker(box, { name: 'two-slots', capacity: 2, agent: 'second-holder' });
  assert.equal((await acquired(first)).acquired, 'first-holder');
  assert.equal((await acquired(second)).acquired, 'second-holder');
  const next = worker(box, { name: 'two-slots', capacity: 2, agent: 'next-waiter' });
  assert.equal((await event(next)).waiting, 1);
  await release(first);
  assert.equal((await event(next)).acquired, 'next-waiter');
  await release(second);
  await release(next);
});

test('gate.io-browser-admission-resources.q2-q3-a-stopped-head-waiter: [Q2,Q3] a stopped head waiter keeps its place ahead of the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const first = worker(box, { agent: 'stopped-first' });
  assert.equal((await event(first)).waiting, 1);
  first.kill('SIGSTOP');
  const second = worker(box, { agent: 'second' });
  assert.equal((await event(second)).waiting, 2);
  await release(holder);
  await assert.rejects(event(second, 800), /worker timed out/u, 'the second waiter cannot jump the stopped head'); // budget: declared negative observation window while the stopped queue head blocks this waiter.
  first.kill('SIGCONT');
  assert.equal((await event(first)).acquired, 'stopped-first');
  await release(first);
  assert.equal((await event(second)).acquired, 'second');
  await release(second);
});

test('gate.io-browser-admission-resources.q2-q3-an-evicted-live-waiter: [Q2,Q3] an evicted live waiter rejoins the FIFO line after it resumes [Q2,Q3]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiter = worker(box, { agent: 'resumed-waiter' });
  assert.equal((await event(waiter)).waiting, 1);
  waiter.kill('SIGSTOP');
  staleIdentity(box, 'waiter', 'resumed-waiter');
  assert.deepEqual(privateList(box)[0].line, []);
  waiter.kill('SIGCONT');
  const rejoined = await event(waiter);
  assert.equal(rejoined.rejoined, true);
  assert.equal(rejoined.waiting, 1);
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'resumed-waiter');
  await release(waiter);
});

test('gate.io-browser-admission-resources.q3-a-live-stalled-holder-keeps: [Q3] a live stalled holder keeps its place beyond the lease timeout', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'stalled-holder', stallMs: 22_000, env: { TZ: 'UTC' } });
  assert.equal((await event(holder)).acquired, 'stalled-holder');
  const waiter = worker(box, { agent: 'queued-behind-live-holder', env: { TZ: 'Pacific/Honolulu', PATH: '/usr/bin' } });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'a live OS process must not be evicted when its heartbeat pauses'); // budget: declared 22000ms holder stall; observe it still held at 20500ms.
  assert.equal((await event(holder, 5_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'queued-behind-live-holder');
  await release(waiter);
});

test('gate.io-browser-admission-resources.q3-concurrent-openers-serialize-migration-of: [Q3] concurrent openers serialize migration of a prior resource database', async () => {
  const box = fixture();
  oldSchema(box);
  const workers = Array.from({ length: 8 }, (_, index) => worker(box, { name: 'legacy', capacity: 8, agent: `migrator-${index}` }));
  const grants = await Promise.all(workers.map((child) => acquired(child)));
  assert.deepEqual(grants.map(({ acquired: agent }) => agent).sort(), workers.map((_, index) => `migrator-${index}`).sort());
  await Promise.all(workers.map(release));
});

test('gate.io-browser-admission-resources.q3-a-held-lease-records-its: [Q3] a held lease records its OS process start identity', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'identity-recorded' });
  assert.equal((await acquired(holder)).acquired, 'identity-recorded');
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const row = db.prepare('SELECT started FROM holder WHERE agent = ?').get('identity-recorded');
    assert.ok(row?.started, 'a readable process identity is stored with its lease');
  } finally { db.close(); }
  await release(holder);
});

test('gate.io-browser-admission-resources.q3-process-identity-lookup-ignores-a: [Q3] process identity lookup ignores a misleading ps on PATH', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'path-spoof-holder' });
  assert.equal((await acquired(holder)).acquired, 'path-spoof-holder');
  expireHeartbeat(box, 'holder', 'path-spoof-holder');
  const fakeBin = join(box.dir, 'fake-bin');
  mkdirSync(fakeBin);
  const fakePs = join(fakeBin, 'ps');
  writeFileSync(fakePs, '#!/bin/sh\nprintf "Mon Jan 1 00:00:00 2001 S\\n"\n');
  chmodSync(fakePs, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    assert.equal(privateList(box)[0].holders[0]?.agent, 'path-spoof-holder', 'the stable absolute ps result keeps the lease');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await release(holder);
});

test('gate.io-browser-admission-resources.q3-an-unreadable-process-identity-keeps: [Q3] an unreadable process identity keeps a live holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-live-holder', stallMs: 27_000 });
  assert.equal((await acquired(holder)).acquired, 'sandbox-live-holder');
  const waiter = worker(box, { agent: 'sandbox-live-waiter', sandboxProcessInfo: true });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'denied process-info access is not proof that a live PID died'); // budget: declared 22000ms holder stall with denied process-info access; observe at 20500ms.
  assert.equal((await event(holder, 8_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await acquired(waiter)).acquired, 'sandbox-live-waiter');
  await release(waiter);
});

test('gate.io-browser-admission-resources.q3-an-unreadable-process-identity-still: [Q3] an unreadable process identity still releases a dead holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-dead-holder' });
  assert.equal((await acquired(holder)).acquired, 'sandbox-dead-holder');
  holder.kill('SIGKILL');
  const { signal } = await holder.finished;
  holder.lines.close();
  assert.equal(signal, 'SIGKILL');
  const waiter = worker(box, { agent: 'sandbox-dead-waiter', sandboxProcessInfo: true });
  assert.equal((await acquired(waiter)).acquired, 'sandbox-dead-waiter');
  await release(waiter);
});

test('gate.io-browser-admission-resources.q3-cached-live-identities-expire-so: [Q3] cached live identities expire so an actual zombie holder is released', { skip: !PERL_FORK }, async () => {
  const box = fixture();
  privateList(box);
  const script = 'my $pid = fork(); die "fork failed" unless defined $pid; if ($pid == 0) { select undef, undef, undef, 1.2; exit 0; } print "$pid\\n"; $| = 1; select undef, undef, undef, 30; waitpid($pid, 0);';
  const reaper = spawn('/usr/bin/perl', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: reaper.stdout });
  try {
    const pidText = await new Promise((resolveLine, reject) => {
      lines.once('line', resolveLine);
      reaper.once('error', reject);
      reaper.once('exit', (code) => reject(new Error(`zombie parent exited early: ${code}`)));
    });
    const pid = Number(pidText);
    assert.ok(Number.isInteger(pid) && pid > 0, `Perl reports its child PID: ${pidText}`);
    insertExpiredHolder(box, { name: 'zombie-cache', pid, agent: 'zombie-holder' });
    const cached = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.equal(cached.holders[0]?.agent, 'zombie-holder', 'the live child with an empty stored identity is kept');
    const cacheAt = Date.now();
    await waitForProcessState(pid, 'Z');
    await delay(Math.max(0, cacheAt + 3_200 - Date.now()));
    const afterExpiry = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.deepEqual(afterExpiry.holders, [], 'the refreshed process state identifies and releases the zombie');
  } finally {
    lines.close();
    if (reaper.exitCode === null && reaper.signalCode === null) {
      reaper.kill('SIGKILL');
      await once(reaper, 'exit');
    }
  }
});

test('gate.io-browser-admission-resources.q3-renew-refuses-after-an-os: [Q3] renew refuses after an OS start-identity mismatch evicts the holder', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'evicted-holder' });
  assert.equal((await event(holder)).acquired, 'evicted-holder');
  staleIdentity(box, 'holder', 'evicted-holder');
  assert.deepEqual(privateList(box)[0].holders, []);
  holder.stdin.write('renew\n');
  assert.equal((await event(holder)).renewError, 'RESOURCE_LEASE_LOST');
  holder.stdin.end('release\n');
  assert.equal((await holder.finished).code, 0, holder.errors);
});

test('gate.io-browser-admission-resources.q3-sigkill-of-a-holder-frees: [Q3] SIGKILL of a holder frees its lease for the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'doomed-holder' });
  assert.equal((await event(holder)).acquired, 'doomed-holder');
  const next = worker(box, { agent: 'successor' });
  const waiting = await event(next);
  assert.equal(waiting.waiting, 1);
  holder.kill('SIGKILL');
  await holder.finished;
  assert.equal((await event(next)).acquired, 'successor');
  await release(next);
});

test('gate.io-browser-admission-resources.q2-q3-a-sigkilled-waiter-is: [Q2,Q3] a SIGKILLed waiter is skipped while the next live waiter advances', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const dead = worker(box, { agent: 'dead-waiter' });
  assert.equal((await event(dead)).waiting, 1);
  const live = worker(box, { agent: 'live-waiter' });
  assert.equal((await event(live)).waiting, 2);
  dead.kill('SIGKILL');
  await dead.finished;
  await release(holder);
  assert.equal((await event(live)).acquired, 'live-waiter');
  await release(live);
});


test('gate.io-browser-admission-resources.the-pool-holds-work-while-the: the pool holds work while the machine is out of memory and names the biggest process [C7]', async () => {
  const box = fixture();
  const reading = join(box.dir, 'memory.json');
  writeMemoryReading(reading, { availableMB: 100, fullAvg10: 99, someAvg10: 99 });
  // Off by default: with no floor set, even a critical machine is never read or held.
  const unset = memoryWorker(box, 'no-floor-run', reading);
  const unsetStart = await event(unset);
  assert.equal(unsetStart.acquired, 'no-floor-run', `with no floor set the pool admits by slots alone: ${JSON.stringify(unsetStart)}`);
  assert.equal(unsetStart.reads, 0, 'with no floor set the pool reads no memory');
  assert.equal(unsetStart.memory, undefined, 'with no floor set nothing is held or reported');
  await release(unset);

  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: 512 } })}\n`);
  const biggest = 'biggest: pid 4242 python3 24.0 GB in /work/journal-reader; pid 4343 python3.12 23.0 GB in /work/other-reader; pid 5151 node 2.0 GB in /work/pullboard';
  writeMemoryReading(reading, { availableMB: 8192, fullAvg10: 42, someAvg10: 80 });
  const run = memoryWorker(box, 'held-run', reading);

  const critical = await event(run);
  assert.equal(critical.acquired, undefined, 'a critical reading must not admit the run');
  assert.equal(critical.waiting, 1, 'the held run keeps its place at the head of the line');
  assert.equal(critical.memory?.held, true, `the run is held for memory: ${JSON.stringify(critical)}`);
  assert.equal(critical.memory.line,
    `memory: holding local gate runs because pressure is critical: pressure critical, 8.0 GB free of 36.0 GB (floor 512 MB); ${biggest}`,
    'one line says why and names the three biggest processes with pid, size and working directory');
  assert.doesNotMatch(critical.memory.line, /\n/u, 'the hold is one line');
  const gate = privateList(box).find(({ name }) => name === 'gate');
  assert.equal(gate.holders.length, 0, 'no run holds a slot while memory is critical, though both slots are free');
  assert.deepEqual(gate.line.map(({ agent }) => agent), ['held-run'], 'the held run waits in the queue');
  await delay(300);
  assert.ok(!run.pendingLines.some((line) => JSON.parse(line).acquired), 'the run stays held while the reading stays critical');

  writeMemoryReading(reading, { availableMB: 400 });
  const low = await event(run);
  assert.equal(low.memory?.held, true, `free memory under the settings floor still holds: ${JSON.stringify(low)}`);
  assert.equal(low.memory.line,
    `memory: holding local gate runs because free memory is under the floor: pressure normal, 400 MB free of 36.0 GB (floor 512 MB); ${biggest}`,
    'the floor comes from gate.memoryFloorMB in pullboard settings');

  writeMemoryReading(reading, { availableMB: 8192 });
  const recovered = await acquired(run).catch((error) => assert.fail(`the held run is admitted once memory recovers: ${error.message.split('\n')[0]}`));
  assert.equal(recovered.acquired, 'held-run', 'the held run is admitted once memory recovers');
  await release(run);
});


});

test('gate.io-browser-admission-resources.q4-machine-capacity-decreases-atomically-refuse: [Q4] machine capacity decreases atomically refuse an occupied or queued resource', async () => {
  const box = fixture();
  const oldHome = process.env.PULLBOARD_HOME;
  const oldMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  const holder = worker(box, { capacity: 2, agent: 'capacity-holder' });
  let secondHolder;
  let waiter;
  try {
    assert.equal((await event(holder)).acquired, 'capacity-holder');
    secondHolder = worker(box, { capacity: 2, agent: 'capacity-second-holder' });
    assert.equal((await event(secondHolder)).acquired, 'capacity-second-holder');
    waiter = worker(box, { capacity: 2, agent: 'capacity-waiter' });
    assert.equal((await event(waiter)).waiting, 1);
    let persisted = false;
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 1, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    assert.equal(persisted, false, 'settings remain unchanged while a holder and waiter exist');
    await release(holder);
    assert.equal((await event(waiter)).acquired, 'capacity-waiter');
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 1, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    await release(waiter);
    await release(secondHolder);
    const changed = setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } });
    assert.deepEqual(changed, { name: 'gate', capacity: 3 });
    assert.equal(persisted, true, 'settings persist under the same queue lock as the capacity');
    assert.equal(privateList(box)[0].capacity, 3);
    const lease = await takeResource({ name: 'gate', capacity: 3, capacityProvider: () => 4, allowIdleCapacityUpdate: true, root: box.first, agent: 'fresh-capacity' });
    assert.equal(privateList(box)[0].capacity, 4, 'a queued gate reads the latest setting after taking the SQLite lock');
    lease.release();
  } finally {
    if (!holder.exitResult) await release(holder);
    if (secondHolder && !secondHolder.exitResult) await release(secondHolder);
    if (waiter && !waiter.exitResult) await release(waiter);
    if (oldHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = oldHome;
    if (oldMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = oldMachineHome;
  }
});

test('gate.io-browser-admission-resources.q1-machine-scope-is-shared-repo: [Q1] machine scope is shared, repo scope stays local, and board scope names relay requirement', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'repo-a', root: box.first });
  assert.equal((await event(holder)).acquired, 'repo-a');
  const otherRepo = worker(box, { agent: 'repo-b', root: box.second });
  assert.equal((await event(otherRepo)).waiting, 1);
  await release(holder);
  assert.equal((await event(otherRepo)).acquired, 'repo-b');
  await release(otherRepo);
  const localA = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-a', root: box.first });
  const localB = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-b', root: box.second });
  assert.equal((await event(localA)).acquired, 'repo-a');
  assert.equal((await event(localB)).acquired, 'repo-b');
  await release(localA);
  await release(localB);
  const refused = spawnSync(process.execPath, ['--input-type=module', '-e', `import {takeResource} from ${JSON.stringify(MODULE)}; await takeResource({name:'x',capacity:1,scope:'board'});`], { env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /BOARD_SCOPE_UNAVAILABLE.*relay/i);
});

test('gate.io-browser-admission-resources.q4-a-red-gate-releases-its: [Q4] a red gate releases its lease before the same process starts another gate', async () => {
  const box = fixture();
  const command = join(box.dir, 'red-then-green.cjs');
  const counter = join(box.dir, 'gate-count');
  const eventsFile = join(box.dir, 'gate-runs.log');
  writeFileSync(command, [
    "const fs = require('node:fs');",
    'const [counter, events] = process.argv.slice(2);',
    'const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0);',
    'fs.writeFileSync(counter, String(count + 1));',
    "fs.appendFileSync(events, 'start\\nend\\n');",
    'process.exit(count === 0 ? 7 : 0);',
  ].join('\n'));
  const gateCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(command)} ${JSON.stringify(counter)} ${JSON.stringify(eventsFile)}`;
  const worker = redGateReleaseSource();
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, gateCommand], {
    cwd: box.first, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the red gate kept its lease and blocked the same process')), 5_000); }), // budget: hang ceiling for the same process to reacquire its released gate slot.
    ]);
    assert.equal(result.code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { firstGreen: false, secondGreen: true });
    assert.deepEqual(readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/u), ['start', 'end', 'start', 'end']);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await closed;
  }
});


/** A write lock on the slot database delays a queued run; only a lock past the deadline stops it, as never ran [C7]. */
test('gate.io-browser-admission-resources.a-gate-slot-waiter-retries-a: a gate-slot waiter retries a locked slot database [C7]', async () => {
  const box = fixture();
  mkdirSync(box.home, { recursive: true });
  const released = join(box.dir, 'lock-released');
  // The waiter's test passes only if the lock was already released when it ran.
  writeFileSync(join(box.first, 'ran.test.js'), `import assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('the waiter ran', () => assert.ok(existsSync(${JSON.stringify(released)})));\n`);
  // The runner refuses a repository with no commit (NO_POLICY), so commit the waiter's test file first.
  for (const args of [['add', 'ran.test.js'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture']]) {
    const committed = spawnSync('git', args, { cwd: box.first, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.failure);
  }
  const env = { ...box.env, PULLBOARD_SLOT_DB_LOCK_MS: '6000' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  /** Hold a write lock on the machine slot database from another process for `ms`; wrapped so awaiting it waits only for the lock. */
  const holdLock = async (ms) => {
    const marker = join(box.dir, `locked-${ms}`);
    const locker = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { writeFileSync } from 'node:fs';
      const [file, marker, ms, released] = process.argv.slice(1);
      const db = new DatabaseSync(file);
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE IF NOT EXISTS lock_probe (x)');
      writeFileSync(marker, 'locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
      db.exec('COMMIT');
      writeFileSync(released, 'released');`, join(box.home, 'resources.sqlite'), marker, String(ms), released], { env });
    await waitForMarker(marker);
    return { done: locker, pid: locker.child.pid, stop: () => locker.child.kill('SIGKILL') };
  };
  /** Run one named test file through the real runner, which waits for a machine gate slot. */
  const runWaiter = () => awaitNestedRun(runFixtureChildAsync(process.execPath, [TEST_RUNNER, 'ran.test.js'], { cwd: box.first, env }));

  const shortLock = await holdLock(3_000);
  const kept = await runWaiter();
  assert.equal((await shortLock.done).status, 0, 'the 3 s lock was taken and released');
  assert.equal(kept.status, 0, `${kept.context}\n${kept.stdout}`);
  assert.match(kept.stdout, /ok \d+ - the waiter ran/u);
  assert.match(kept.stdout, /^# fail 0$/mu);

  rmSync(released);
  const longLock = await holdLock(60_000);
  try {
    const stopped = await runWaiter();
    assert.equal(stopped.status, 75, stopped.context);
    assert.match(stopped.stderr, /never ran/u);
    assert.match(stopped.stderr, /not a test failure/u);
    assert.match(stopped.stderr, new RegExp(`pid ${longLock.pid}\\b`, 'u'), 'names the process holding the lock');
    assert.doesNotMatch(stopped.stdout, /the waiter ran/u);
  } finally { longLock.stop(); await longLock.done; }
});




