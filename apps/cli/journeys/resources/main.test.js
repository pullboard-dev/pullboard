/** @pullboard-test-input apps/cli/pullboard.js */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** Resource queue cases that drive the real CLI (settings, check, verify) or the fixtures that start it [Q1,Q2,Q4,C7,V4]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkNeedsBrowser } from '../../../../packages/gate/index.js';
import { queuedLeaseProof } from '../../../../packages/gate/tests/fixtures/resources/lease.js';
import { openPrivateScopedView } from '../../../../packages/gate/tests/fixtures/resources/lease.js';
import { resourceNames } from '../../tests/fixtures/resources/lease.js';
import { checkProject } from '../../../../packages/gate/tests/fixtures/resources/verify.js';
import { verificationProject } from '../../../../packages/gate/tests/fixtures/resources/verify.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAddArgv } from '../../tests/fixtures/testkit.js';
import { CHILDREN } from '../../tests/fixtures/resources/pool.js';
import { SUBMIT_CHECK } from '../../tests/fixtures/resources/pool.js';
import { acquired } from '../../tests/fixtures/resources/pool.js';
import { event } from '../../tests/fixtures/resources/pool.js';
import { fixture } from '../../tests/fixtures/resources/pool.js';
import { memoryWorker } from '../../tests/fixtures/resources/pool.js';
import { poolWorker } from '../../tests/fixtures/resources/pool.js';
import { privateList } from '../../tests/fixtures/resources/pool.js';
import { privateTake } from '../../tests/fixtures/resources/pool.js';
import { release } from '../../tests/fixtures/resources/pool.js';
import { requeuedRemoteRun } from '../../tests/fixtures/resources/pool.js';
import { setBrowserFreeChecks } from '../../tests/fixtures/resources/pool.js';
import { setQueueOrder } from '../../tests/fixtures/resources/pool.js';
import { waitForMarker } from '../../tests/fixtures/resources/pool.js';
import { waitUntil } from '../../tests/fixtures/resources/pool.js';
import { worker } from '../../tests/fixtures/resources/pool.js';
import { writeMemoryReading } from '../../tests/fixtures/resources/pool.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const LEASE_HELPERS = createE2eHelpers();
after(() => LEASE_HELPERS.cleanup());

test('a non-browser check does not wait for the browser slot [C7]', async () => {
  const box = fixture();
  setBrowserFreeChecks(box, true);
  const { repo, base } = checkProject(box);
  const itemCheck = 'node apps/cli/src/io/run/tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  const submitCheck = 'node apps/cli/src/io/run/tests.js --test-name-pattern "submit check marker" test/cpu-check.test.js';
  const classifyEnv = { ...process.env, NODE_OPTIONS: '' };
  assert.equal(await checkNeedsBrowser(repo, itemCheck, { env: classifyEnv }), false, 'an explicit CPU-only test file is classifiable');
  assert.equal(await checkNeedsBrowser(repo, 'node apps/cli/src/io/run/tests.js test/cockpit/brief.test.js', { env: classifyEnv }), true,
    'a named file with no readable declaration stays browser-gated');
  const added = runFixtureChild(process.execPath, [...fixtureAddArgv(BIN), 'coordinator', 'CPU check item', '--check', itemCheck, '--route', 'strong', '--wait', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const item = JSON.parse(added.stdout).item.item_id;
  assert.equal(existsSync(join(repo, 'item-check-started')), false, 'the setup baseline ran in its private clone');

  const browserHolder = poolWorker(box, { agent: 'check-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(browserHolder);
  const itemMarker = join(repo, 'item-check-started');
  const itemStarted = waitForMarker(itemMarker);
  const itemRun = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
  let itemResult;
  try {
    await itemStarted;
    assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'check-browser-holder'),
      'the item check starts while the unrelated browser lease remains held');
  } finally {
    await release(browserHolder);
    itemResult = await itemRun;
  }
  assert.equal(itemResult.status, 0, itemResult.failure ?? itemResult.stderr);
  assert.equal(readFileSync(itemMarker, 'utf8'), 'started');

  const nextBrowserHolder = poolWorker(box, { agent: 'submit-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(nextBrowserHolder);
  const submitMarker = join(repo, 'submit-check-started');
  const submitStarted = waitForMarker(submitMarker);
  const submitRun = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', SUBMIT_CHECK, repo, base, submitCheck], { cwd: repo, env: box.env });
  let submitResult;
  let submitStartFailure = null;
  try {
    try { await submitStarted; }
    catch (error) { submitStartFailure = error; }
    assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'submit-browser-holder'),
      'the submission check starts while the unrelated browser lease remains held');
  } finally {
    await release(nextBrowserHolder);
    submitResult = await submitRun;
  }
  assert.equal(submitStartFailure, null, `${submitStartFailure?.message ?? ''}\n${submitResult.stdout}\n${submitResult.stderr}`);
  assert.equal(submitResult.status, 0, submitResult.failure ?? submitResult.stderr);
  assert.deepEqual(JSON.parse(submitResult.stdout), {
    green: true, full: false, reason: '', files: ['test/cpu-check.test.js'], checkGreen: true,
  }, submitResult.stderr);
});

test('browser-free checks skip the slot only when the machine allows it [C7]', async () => {
  const box = fixture();
  const { repo } = checkProject(box);
  const check = `out=$(node apps/cli/src/io/run/tests.js --test-name-pattern "item check marker" test/cpu-check.test.js 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | grep -Eq '^[[:space:]]*ok [0-9]+ - item check marker' && printf '%s\\n' "$out" | grep -Eq '^# fail 0$'`;
  const added = runFixtureChild(process.execPath, [...fixtureAddArgv(BIN), 'coordinator', 'Browser-free policy check', '--check', check, '--route', 'strong', '--wait', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const item = JSON.parse(added.stdout).item.item_id;
  const marker = join(repo, 'item-check-started');

  async function checkWithPolicy(value, shouldStartWithBrowserHeld) {
    setBrowserFreeChecks(box, value);
    rmSync(marker, { force: true });
    const browserHolder = poolWorker(box, { agent: `policy-browser-${String(value)}`, browser: true, item: '681', kind: 'gate' });
    await acquired(browserHolder);
    const started = waitForMarker(marker);
    const startedOutcome = started.then(() => null, error => error);
    const resultPromise = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
    let result;
    try {
      if (shouldStartWithBrowserHeld) {
        await started;
        assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === `policy-browser-${String(value)}`),
          'the browser lease stays live while an opted-in browser-free check runs');
      } else {
        await waitUntil(() => privateList(box).find(({ name }) => name === 'gate')?.line.some(({ kind, item: waitingItem }) => kind === 'check' && waitingItem === String(item)),
          'a browser-disabled check to wait in the gate queue');
        assert.equal(existsSync(marker), false, 'the check does not start while browser-free checks are disabled or absent');
      }
    } finally {
      await release(browserHolder);
      result = await resultPromise;
    }
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    assert.equal(await startedOutcome, null, 'the check marker observer settles and closes');
    assert.equal(readFileSync(marker, 'utf8'), 'started');
  }

  await checkWithPolicy(false, false);
  await checkWithPolicy(true, true);
  await checkWithPolicy(undefined, false);
});

test('a review waiting in the pool keeps its lease [C7,V4]', {
  timeout: 120_000, // budget: real private Git/CLI setup and causally controlled queue/run/death phases, never a production lease extension.
}, (t) => queuedLeaseProof(t, { helpers: LEASE_HELPERS, children: CHILDREN, fixture, poolWorker, privateList, privateTake, acquired, release, waitUntil }));

/** Prove the machine setting changes real browser admission while retaining the single-slot default [C7]. */
test('queue order follows the machine settings [C7,O5]', async () => {
  const gate = (box) => privateList(box).find(({ name }) => name === 'gate');
  const line = (box) => gate(box).line.map(({ agent, queueClass: listed, agedFrom }) => [agent, listed, agedFrom ?? '']);
  /** Backdate a waiter's queued time: the test clock that stands in for real waiting. */
  const backdate = (box, agent, ms) => {
    const queuedAt = new Date(Date.now() - ms).toISOString();
    const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
    // The pool's own processes write this file too; wait for their lock instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    let changed;
    try { changed = db.prepare('UPDATE waiter SET since = ? WHERE agent = ?').run(queuedAt, agent).changes; }
    finally { db.close(); }
    assert.equal(changed, 1, `${agent} has a private waiter row`);
  };
  /** Run pullboard settings against the fixture's private machine home. */
  const settingsCli = (box, ...flags) => runFixtureChild(process.execPath, [BIN, 'settings', ...flags], { cwd: box.first, env: box.env, encoding: 'utf8' });

  // No settings: landings first, then arrival, so a review waits behind an earlier focused run.
  const plain = fixture();
  const plainHolders = [poolWorker(plain, { agent: 'plain-holder-one' }), poolWorker(plain, { agent: 'plain-holder-two' })];
  for (const holder of plainHolders) await acquired(holder);
  const plainFocused = poolWorker(plain, { agent: 'plain-focused', kind: 'focused' });
  assert.equal((await event(plainFocused)).queued.position, 1);
  const plainReview = poolWorker(plain, { agent: 'plain-review', kind: 'review', item: '697' });
  assert.equal((await event(plainReview)).queued.position, 2, 'with no settings a review waits its arrival turn');
  assert.deepEqual(gate(plain).line.map(({ agent }) => agent), ['plain-focused', 'plain-review'], 'with no settings the line is in arrival order');
  // agingMinutes alone does nothing: aging is used only while a class order is on.
  setQueueOrder(plain, { agingMinutes: 1 });
  backdate(plain, 'plain-review', 5 * 60_000);
  assert.deepEqual(line(plain), [['plain-focused', 'other', ''], ['plain-review', 'review', '']],
    'with reviewsFirst off no waiter ages up, even with a short agingMinutes');
  setQueueOrder(plain, undefined);
  const plainPrinted = settingsCli(plain);
  assert.equal(plainPrinted.status, 0, plainPrinted.stderr);
  assert.match(plainPrinted.stdout, /^gate\.queue\.reviewsFirst: false\b/mu, 'pullboard settings prints reviewsFirst, default false');
  assert.match(plainPrinted.stdout, /^gate\.queue\.agingMinutes: 30\b/mu, 'pullboard settings prints agingMinutes, default 30');
  await release(plainHolders[0]);
  assert.equal((await acquired(plainFocused)).acquired, 'plain-focused', 'with no settings the earlier focused run is admitted first');
  await release(plainHolders[1]);
  assert.equal((await acquired(plainReview)).acquired, 'plain-review');
  await release(plainFocused);
  await release(plainReview);

  // reviewsFirst true: the same review is admitted ahead of the earlier focused run.
  const classed = fixture();
  setQueueOrder(classed, { reviewsFirst: true });
  const classedHolders = [poolWorker(classed, { agent: 'classed-holder-one' }), poolWorker(classed, { agent: 'classed-holder-two' })];
  for (const holder of classedHolders) await acquired(holder);
  const classedFocused = poolWorker(classed, { agent: 'classed-focused', kind: 'focused' });
  assert.equal((await event(classedFocused)).queued.position, 1);
  const classedReview = poolWorker(classed, { agent: 'classed-review', kind: 'review', item: '697' });
  assert.equal((await event(classedReview)).queued.position, 1, 'with reviewsFirst true a review joins ahead of focused runs');
  assert.deepEqual(gate(classed).line.map(({ agent }) => agent), ['classed-review', 'classed-focused'], 'with reviewsFirst true the line is in class order');
  await release(classedHolders[0]);
  assert.equal((await acquired(classedReview)).acquired, 'classed-review', 'with reviewsFirst true the review is admitted first');
  await release(classedHolders[1]);
  assert.equal((await acquired(classedFocused)).acquired, 'classed-focused');
  await release(classedReview);
  await release(classedFocused);

  // agingMinutes 1: a focused run waiting just over a minute moves up one class, ahead of a later submit.
  const aging = fixture();
  setQueueOrder(aging, { reviewsFirst: true, agingMinutes: 1 });
  const agingHolders = [poolWorker(aging, { agent: 'aging-holder-one' }), poolWorker(aging, { agent: 'aging-holder-two' })];
  for (const holder of agingHolders) await acquired(holder);
  const agingFocused = poolWorker(aging, { agent: 'aging-focused', kind: 'focused' });
  await event(agingFocused);
  const agingSubmit = poolWorker(aging, { agent: 'aging-submit', kind: 'submit', item: '697' });
  assert.equal((await event(agingSubmit)).queued.position, 1, 'a fresh submit goes ahead of a fresh focused run');
  assert.deepEqual(line(aging), [['aging-submit', 'submit', ''], ['aging-focused', 'other', '']]);
  backdate(aging, 'aging-focused', 61_000);
  assert.deepEqual(line(aging), [['aging-focused', 'submit', 'other'], ['aging-submit', 'submit', '']],
    'after agingMinutes 1 the focused run ranks with submits and keeps its earlier ticket there');
  const agingPrinted = settingsCli(aging);
  assert.equal(agingPrinted.status, 0, agingPrinted.stderr);
  assert.match(agingPrinted.stdout, /^gate\.queue\.reviewsFirst: true$/mu, 'pullboard settings prints the reviewsFirst set on this machine');
  assert.match(agingPrinted.stdout, /^gate\.queue\.agingMinutes: 1$/mu, 'pullboard settings prints the agingMinutes set on this machine');
  assert.deepEqual(JSON.parse(settingsCli(aging, '--json').stdout).settings.gate.queue, { reviewsFirst: true, currentReleaseFirst: false, agingMinutes: 1 });
  await release(agingHolders[0]);
  assert.equal((await acquired(agingFocused)).acquired, 'aging-focused', 'the aged focused run is admitted before the later submit');
  await release(agingHolders[1]);
  assert.equal((await acquired(agingSubmit)).acquired, 'aging-submit');
  await release(agingFocused);
  await release(agingSubmit);
  // The class rule against an injected clock: one class per agingMinutes waited.
  const { queueClass } = await import('../../../../packages/resources/index.js');
  const queuedAt = Date.parse('2026-10-16T16:00:00.000Z');
  const since = new Date(queuedAt).toISOString();
  assert.deepEqual([0, 0.99, 1, 2, 3].map((minutes) => queueClass({ kind: 'focused', since }, queuedAt + minutes * 60_000, 60_000).name),
    ['other', 'other', 'submit', 'review', 'landing'], 'a one-minute aging moves a waiting run up one class per minute');

  // A remote run whose runner drops is requeued: with no settings it takes #663's front ticket,
  // ahead of every other non-landing waiter, as before; with reviewsFirst true it keeps its original
  // ticket, so it waits behind an earlier run of its own class, and the pool stays in class order
  // (the requeue is marked classed, so it never forces arrival).
  const requeuedOff = await requeuedRemoteRun(undefined);
  assert.equal(requeuedOff.order, undefined);
  assert.deepEqual(requeuedOff.line, [
    ['remote-focused', 'other'], ['focused-early', 'other'], ['submit-later', 'submit'], ['review-later', 'review'],
  ], 'with no settings the requeued remote run goes first and the rest keep arrival order');
  assert.ok(requeuedOff.tickets['remote-focused'] < 0, 'with no settings the requeued run takes the front ticket, as on main');
  assert.deepEqual(requeuedOff.admitted, ['remote-focused', 'focused-early', 'submit-later', 'review-later']);
  const requeuedOn = await requeuedRemoteRun({ reviewsFirst: true });
  assert.equal(requeuedOn.order, undefined, 'with reviewsFirst true a requeued remote run keeps the pool in class order');
  assert.deepEqual(requeuedOn.line, [
    ['review-later', 'review'], ['submit-later', 'submit'], ['focused-early', 'other'], ['remote-focused', 'other'],
  ], 'with reviewsFirst true the requeued remote run keeps its arrival place in its class');
  assert.equal(requeuedOn.tickets['remote-focused'], requeuedOn.lastIssued, 'with reviewsFirst true the requeued run keeps its original ticket');
  assert.deepEqual(requeuedOn.admitted, ['review-later', 'submit-later', 'focused-early', 'remote-focused']);

  // Mixed versions agree on the next waiter. A #651-only process ranks by class only when every
  // waiter is marked classed=1, and otherwise landings first, then ticket; a #697 process follows
  // its setting and marks its waiters to match, so both rankers pick the same waiter off and on.
  const { queueClass: classOf } = await import('../../../../packages/resources/index.js');
  const agree = fixture();
  const agreeHolders = [poolWorker(agree, { agent: 'agree-holder-one' }), poolWorker(agree, { agent: 'agree-holder-two' })];
  for (const holder of agreeHolders) await acquired(holder);
  const agreeFocused = poolWorker(agree, { agent: 'agree-focused', kind: 'focused' });
  await event(agreeFocused);
  const agreeReview = poolWorker(agree, { agent: 'agree-review', kind: 'review', item: '697' });
  await event(agreeReview);
  /** The raw waiter rows every process reads. */
  const rows = () => {
    const db = new DatabaseSync(join(agree.home, 'resources.sqlite'));
    // The pool's own processes write this file too; wait for their lock instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    try { return db.prepare("SELECT ticket, agent, since, landing, item_check AS itemCheck, diagnostic, kind, classed FROM waiter WHERE name = 'gate'").all(); }
    finally { db.close(); }
  };
  /** The next waiter as a #651-only process ranks the same rows. */
  const next651 = (waiters) => {
    const byClass = waiters.every((waiter) => waiter.classed === 1);
    const rank = (waiter) => (byClass ? classOf(waiter, Date.now()).effective : waiter.landing === 1 ? 0 : 1);
    return [...waiters].sort((left, right) => rank(left) - rank(right) || left.ticket - right.ticket)[0].agent;
  };
  assert.deepEqual(rows().map(({ classed }) => classed), [0, 0], 'with reviewsFirst off a waiter is marked as not admitting by class');
  assert.equal(next651(rows()), gate(agree).line[0].agent, 'off: a #651-only process and this one pick the same next waiter');
  assert.equal(gate(agree).line[0].agent, 'agree-focused', 'off: both pick by arrival');
  setQueueOrder(agree, { reviewsFirst: true });
  // Each waiter re-marks itself on its next poll, so a setting change reaches every ranking.
  for (let tries = 0; rows().some(({ classed }) => classed !== 1); tries += 1) {
    assert.ok(tries < 250, 'waiters re-mark themselves after the setting turns on');
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
  assert.equal(next651(rows()), gate(agree).line[0].agent, 'on: a #651-only process and this one pick the same next waiter');
  assert.equal(gate(agree).line[0].agent, 'agree-review', 'on: both pick by class');
  await release(agreeHolders[0]);
  assert.equal((await acquired(agreeReview)).acquired, 'agree-review');
  await release(agreeHolders[1]);
  assert.equal((await acquired(agreeFocused)).acquired, 'agree-focused');
  await release(agreeReview);
  await release(agreeFocused);

  // An unusable value is refused by name, with the fix.
  setQueueOrder(aging, { reviewsFirst: 'yes' });
  const badFlag = settingsCli(aging, '--json');
  assert.equal(badFlag.status, 1, 'a non-boolean reviewsFirst is refused');
  assert.equal(JSON.parse(badFlag.stdout).error.code, 'BAD_MACHINE_SETTINGS');
  assert.match(JSON.parse(badFlag.stdout).error.message, /gate\.queue\.reviewsFirst .* must be true or false/u);
  setQueueOrder(aging, { reviewsFirst: true, agingMinutes: 0 });
  const badAging = settingsCli(aging, '--json');
  assert.equal(badAging.status, 1, 'agingMinutes 0 is refused');
  assert.match(JSON.parse(badAging.stdout).error.message, /gate\.queue\.agingMinutes .* must be a positive whole number/u);
});

test('the memory hold is off until a floor is set, an unread machine warns once, and resources prints the memory line [C7]', async () => {
  const { gateWaitReporter } = await import('../../../../packages/gate/index.js');
  const said = [];
  const report = gateWaitReporter({ say: (line) => said.push(line) });
  report({ holders: [], position: 1, memory: { checked: true, held: true, line: 'memory: holding the gate queue because pressure is critical: first' } });
  report({ holders: [], position: 1, memory: { checked: true, held: true, line: 'memory: holding the gate queue because pressure is critical: sizes moved' } });
  report({ holders: [], position: 1 });
  assert.deepEqual(said, ['memory: holding the gate queue because pressure is critical: first', 'gate waiting: 0 running; place 1'],
    'a held run prints its line once per hold, then the ordinary queue line');
  const warned = [];
  const warn = gateWaitReporter({ say: (line) => warned.push(line) });
  const unchecked = { checked: false, held: false, line: 'memory: not checked on win32', warning: 'memory: not checked on win32' };
  warn({ holders: [], line: [], position: 0, memory: unchecked });
  warn({ holders: [], line: [], position: 0, memory: unchecked });
  assert.deepEqual(warned, ['memory: not checked on win32'], 'an unread machine prints one warning');

  const box = fixture();
  const critical = join(box.dir, 'critical.json');
  writeMemoryReading(critical, { availableMB: 100, fullAvg10: 99 });
  const unset = memoryWorker(box, 'unset-run', critical);
  const unsetStart = await event(unset);
  assert.equal(unsetStart.acquired, 'unset-run', `with gate.memoryFloorMB absent the pool admits by slots alone, as before: ${JSON.stringify(unsetStart)}`);
  await release(unset);
  const defaults = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(JSON.parse(defaults.stdout).memoryFloorMB, null, 'pullboard settings reports the hold as off when the floor is absent');
  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: -1 } })}\n`);
  const refused = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, 'BAD_MACHINE_SETTINGS');
  assert.match(JSON.parse(refused.stdout).error.message, /gate\.memoryFloorMB/u);
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: 1024 } })}\n`);
  const set = runFixtureChild(process.execPath, [BIN, 'settings'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^gate\.memoryFloorMB: 1024$/mu, 'pullboard settings shows the floor once it is set');

  for (const source of ['win32', 'broken']) {
    const file = join(box.dir, `${source}.json`);
    writeMemoryReading(file, { availableMB: 100, fullAvg10: 99, broken: true });
    const run = memoryWorker(box, `${source}-run`, source === 'win32' ? 'win32' : file);
    const first = await event(run);
    assert.equal(first.memory?.checked, false, `${source}: the run hears that memory is not checked: ${JSON.stringify(first)}`);
    assert.match(first.memory.warning, /^memory: not checked on (win32|linux) \(.+\); the gate pool admits by slots alone$/u);
    assert.equal((await event(run)).acquired, `${source}-run`, `${source}: an unread machine admits as today, after exactly one warning`);
    await release(run);
  }

  checkProject(box);
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: {} })}\n`);
  const off = runFixtureChild(process.execPath, [BIN, 'resources', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).memory, null, 'with no floor set pullboard resources reads no memory');
  const offHuman = runFixtureChild(process.execPath, [BIN, 'resources'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(offHuman.status, 0, offHuman.stderr);
  assert.doesNotMatch(offHuman.stdout, /^memory: /mu, 'with no floor set pullboard resources prints no memory line');
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: 1024 } })}\n`);
  const human = runFixtureChild(process.execPath, [BIN, 'resources'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(human.status, 0, human.stderr);
  const printed = human.stdout.split('\n').filter((line) => line.startsWith('memory: '));
  assert.equal(printed.length, 1, `pullboard resources prints one machine memory line: ${human.stdout}`);
  assert.match(printed[0], /^memory: (admitting: |holding the gate queue because |not checked on )/u);
  const json = runFixtureChild(process.execPath, [BIN, 'resources', '--json'], { cwd: box.first, env: box.env, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).memory.line, /^memory: /u, 'the JSON result carries the same machine line');
});

test('a verification with no frozen check never enters the test queue [C7,V4]', async t => {
  const { project, box, item, reviewer } = verificationProject(t);
  const holder = worker(box, { agent: 'empty-check-holder' });
  await acquired(holder);
  let completed;
  const verifying = runFixtureChildAsync(process.execPath, [BIN, 'verify', String(item), 'accept', '--note', 'The private bar holds.', '--json'],
    { cwd: reviewer, env: project.env }).then(result => { completed = result; return result; });
  try {
    await waitUntil(() => completed || privateList(box).find(row => row.name === 'gate')?.line.some(row => row.item === String(item)),
      'the verification to finish or enter its private queue');
    const gate = privateList(box).find(row => row.name === 'gate');
    assert.equal(gate.line.some(row => row.item === String(item)), false, 'an empty frozen check must not add a native waiter');
    assert.ok(gate.holders.some(row => row.agent === 'empty-check-holder'), 'the unrelated holder remains occupied throughout verification');
    assert.ok(completed, 'the verifier completed without waiting for that holder');
    assert.equal(completed.status, 0, completed.failure ?? completed.stderr);
    assert.equal(JSON.parse(completed.stdout).check, 'none');
    assert.equal(privateList(box).find(row => row.name === 'browser')?.line.some(row => row.item === String(item)) ?? false, false,
      'an empty frozen check adds no browser waiter either');
  } finally { await release(holder); await verifying; }
});

test('a verification with a frozen check still waits for its slot [C7,V4]', async t => {
  const { project, box, item, reviewer, marker } = verificationProject(t, { checked: true, landed: true });
  rmSync(marker, { force: true });
  const holder = worker(box, { agent: 'real-check-holder' });
  await acquired(holder);
  let completed;
  const verifying = runFixtureChildAsync(process.execPath, [BIN, 'verify', String(item), 'accept', '--note', 'The exact frozen command passed.', '--json'],
    { cwd: reviewer, env: project.env }).then(result => { completed = result; return result; });
  try {
    await waitUntil(() => completed || privateList(box).find(row => row.name === 'gate')?.line.some(row => row.item === String(item)),
      'the nonempty frozen check to enter its private queue');
    assert.equal(privateList(box).find(row => row.name === 'gate').line.some(row => row.item === String(item)), true,
      `a real frozen command keeps the normal native admission boundary\n${completed?.stdout}\n${completed?.stderr}`);
    assert.equal(completed, undefined, 'the check cannot finish while its slot remains occupied');
    assert.equal(existsSync(marker), false, 'the frozen command has not run early');
  } finally { await release(holder); await verifying; }
  assert.equal(completed.status, 0, completed.failure ?? completed.stderr);
  assert.equal(JSON.parse(completed.stdout).check, 'green');
  assert.equal(readFileSync(marker, 'utf8'), 'check-ran', 'the unchanged frozen command ran after admission');
});

test('a stopped view leaves no view-port row [C7]', async () => {
  const box = fixture();
  const name = (port) => `view-port-${port}`;
  const names = () => resourceNames(box.home);
  const leases = [];
  let dead, holder, waiter, view;
  try {
    privateList(box);
    const baseline = names().filter((entry) => entry.startsWith('view-port-')).length;
    view = await openPrivateScopedView(box);
    const stopped = await privateTake(box, { name: name(view.port), capacity: 1, agent: 'view-port-stopped' });
    leases.push(stopped);
    assert.ok(names().includes(stopped.name), 'the running view has a resource row for its bound port');
    await view.close(); view = null;
    stopped.release(); leases.pop();
    assert.equal(names().filter((entry) => entry.startsWith('view-port-')).length, baseline,
      'stopping the view and releasing its final lease returns to the prior view-port count');

    dead = worker(box, { name: name(4892), agent: 'view-port-dead' });
    await acquired(dead);
    dead.kill('SIGKILL'); await dead.finished; dead.lines.close();
    assert.ok(!privateList(box).some(({ name: entry }) => entry === name(4892)), 'the next resource read sweeps a dead view and its empty port row');

    holder = worker(box, { name: name(4893), agent: 'view-port-holder' });
    await acquired(holder);
    waiter = worker(box, { name: name(4893), agent: 'view-port-waiter' });
    await waitUntil(() => privateList(box).find(({ name: entry }) => entry === name(4893))?.line.some(({ agent }) => agent === 'view-port-waiter'),
      'a same-port view waits behind the live holder');
    assert.ok(names().includes(name(4893)), 'a live holder and queued view retain their port row');
    await release(holder); holder = null;
    await acquired(waiter);
    assert.ok(names().includes(name(4893)), 'the waiting view keeps the row when it acquires the released port');
    await release(waiter); waiter = null;
    assert.ok(!names().includes(name(4893)), 'releasing the final view removes its port row');

    for (const resource of ['gate', 'ordinary', 'View-Port-4894']) {
      const lease = await privateTake(box, { name: resource, capacity: 1, agent: `${resource}-fixture` });
      leases.push(lease); lease.release(); leases.pop();
    }
    const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
    try { db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run('runner:fixture-host', 2); }
    finally { db.close(); }
    privateList(box);
    const kept = names();
    assert.ok(kept.includes('gate') && kept.includes('ordinary') && kept.includes('View-Port-4894') && kept.includes('runner:fixture-host'),
      'empty gate, ordinary, case-distinct view-like, and runner definitions are preserved');
  } finally {
    try {
      for (const lease of leases.reverse()) lease.release();
      if (dead && !dead.exitResult) { dead.kill('SIGKILL'); await dead.finished; dead.lines.close(); }
      for (const child of [holder, waiter]) if (child && !child.exitResult) await release(child);
    } finally { if (view) await view.close(); }
  }
});
