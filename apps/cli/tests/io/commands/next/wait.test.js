/** @pullboard-test-input apps/cli/src/io/commands/next.js */
/** A real next --wait on a board other seats keep writing burns under half a CPU second and still wakes at once when an item is offered [C7,#11794,#11798]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { withFixtureBoard } from '../../../fixtures/board.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { startBoardWriter } from '../../../fixtures/board-writer.js';
import { main } from '../../../fixtures/native.js';
import { captureCommandInProcess } from '../../../fixtures/process.js';
import { createFixtureWorktree } from '../../../fixtures/testkit.js';
import { fixtureAdd } from '../../../fixtures/testkit.js';

const WAIT_MINUTES = '0.1';
const OFFER_WAKE_SECONDS = 1;
const FAKE_WAIT_MS = 2 * 60_000;
const FAKE_STEP_MS = 30_000;

/** Run the production next command in this process and answer its result with the process CPU seconds and wall seconds it took. */
async function measured(box, cwd, ...args) {
  const cpuBefore = process.cpuUsage(), began = Date.now();
  const result = await box.inProcess(cwd, 'next', ...args);
  const used = process.cpuUsage(cpuBefore);
  return { ...result, cpu: (used.user + used.system) / 1e6, seconds: (Date.now() - began) / 1000 };
}

test('cli.io-commands-next-wait.busy-board-cpu: clause 1: a real next --wait on a fixture board with nothing to take, while a separate process writes the board every 50 ms for 5 s, returns its idle answer without an error and uses under 0.5 s of process CPU beyond one plain next [C7,#11794,#11798]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), repo = join(box.dir, 'busy-board');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal((await box.runLocal(repo, 'init')).code, 0);
  if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  assert.equal((await box.runLocal(repo, 'lane', 'add', 'app', '--owns', 'app/')).code, 0);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up the busy board');
  const made = await createFixtureWorktree(box, repo, 'app', { run: box.runLocal });
  assert.equal(made.code, 0, made.out + made.err);
  const seat = JSON.parse(made.out).path;
  // One plain answer first warms this process's modules, so the next one is the cost of answering once.
  await measured(box, seat, '--no-wait');
  const plain = await measured(box, seat, '--no-wait');
  const writing = startBoardWriter(join(repo, '.git', 'pullboard', 'board.sqlite'));
  const waiting = await measured(box, seat, '--wait', WAIT_MINUTES);
  const wrote = await writing;
  assert.equal(wrote.code, 0, wrote.err);
  assert.doesNotMatch(waiting.err, /\n\s+at [^\n]*\.js:\d+/u, `the wait ended in an error: ${waiting.err}`);
  assert.equal(waiting.code, 4, `exit ${waiting.code}: ${waiting.err}`);
  assert.match(waiting.out + waiting.err, /\[IDLE_TIMEOUT\]/u, `the wait omitted its idle line: ${waiting.out}${waiting.err}`);
  assert.ok(waiting.seconds >= 5, `the wait returned after ${waiting.seconds} s, so it did not wait under the writes: ${waiting.err}`);
  const figure = Math.round((waiting.cpu - plain.cpu) * 100) / 100;
  t.diagnostic(`the wait ran ${waiting.seconds} s, exit ${waiting.code}: ${(waiting.out + waiting.err).replace(/\s+/gu, ' ').slice(0, 300)}`);
  t.diagnostic(`next --wait under board writes: process CPU ${waiting.cpu} s in all, ${plain.cpu} s for one plain next, so ${figure} s for the wait over ${Number(WAIT_MINUTES) * 60} s of writes`);
  assert.ok(figure < 0.5, `the wait burned ${figure} s of process CPU over ${Number(WAIT_MINUTES) * 60} s of writes that changed nothing this seat can take; the limit is 0.5 s`);
  console.log(`BUSY_BOARD_WAIT_CPU_SECONDS ${figure} (total ${waiting.cpu}, plain next ${plain.cpu})`);
});

test('cli.io-commands-next-wait.wakes-on-offer: clause 2: the same waiting next returns within 1 s of an item becoming takeable for it [C7,#11798]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  box.env.PULLBOARD_NEXT_PROFILE = '1';
  const began = Date.now(), notifications = [];
  let subscribed;
  const ready = new Promise(resolve => { subscribed = resolve; });
  // This diagnostic clock uses the actual time and native waiter, without changing any deadline.
  const clock = { now: Date.now, sleep: async (wake, options) => {
    if (notifications.length < 64) notifications.push({ sleepAt: Date.now() - began, after: options.after, until: options.deadline - began });
    const sleeping = wake.wait(options);
    if (wake.version() === options.after && Date.now() < options.deadline) subscribed();
    await sleeping;
    if (notifications.length < 64) notifications.push({ wokeAt: Date.now() - began, after: options.after, version: wake.version() });
  } };
  const waiting = drivenNext(box, box.web, clock, '--wait', '1').then(result => ({ ...result, finishedAt: Date.now() }));
  // The first idle event precedes sleep; wait for the actual native subscription before offering work.
  const board = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  await ready;
  const added = await fixtureAdd(box.runAsync, box.repo, 'web', 'Offered while a seat waits', '--specs', 'G1', '--criterion', 'renders', '--json');
  assert.equal(added.status ?? added.code, 0, `${added.out ?? added.stdout}\n${added.err ?? added.stderr}`);
  const item = JSON.parse(added.out ?? added.stdout).item;
  const filed = withFixtureBoard(board, open => open.db.prepare("SELECT event_at FROM event WHERE event_kind='add' AND item_id=? ORDER BY event_id DESC LIMIT 1").get(item.item_id));
  const filedAt = Date.parse(filed.event_at);
  assert.ok(Number.isFinite(filedAt), 'the board records the actual add timestamp');
  t.diagnostic(`item ${item.item_id} status ${item.item_status} filed ${(filedAt - began) / 1000} s after the wait began`);
  const result = await waiting;
  const delay = (result.finishedAt - filedAt) / 1000;
  assert.ok(result.finishedAt >= filedAt, 'the waiting command answers after the committed add');
  assert.ok(notifications.some(entry => entry.wokeAt + began >= filedAt && entry.version !== entry.after),
    'the native file waiter received a notification after the add');
  t.diagnostic(`native offer wake ${delay} s; notifications ${JSON.stringify(notifications)}; ${result.err.replace(/\s+/gu, ' ')}`);
  assert.equal(result.code, 0, `filed ${(filedAt - began) / 1000} s in, item ${JSON.stringify(item).slice(0, 400)}: ${result.out}\n${result.err}`);
  assert.match(result.out, new RegExp(`#${item.item_id}\\b`, 'u'), `the wait did not hand over the offered item: ${result.out}`);
  assert.ok(delay < OFFER_WAKE_SECONDS, `the wait returned ${delay} s after the item was filed`); // budget: declared by the bar of #11798 clause 2
});

/** A next run through the production command with a driven clock: now() reads it, and each sleep hands it to `sleep`. */
function drivenNext(box, cwd, clock, ...args) {
  return captureCommandInProcess((argv, io) => main(argv, { ...io, nextWaitClock: clock }), ['next', ...args], { cwd, env: box.env });
}

test('cli.io-commands-next-wait.fake-clock-idle: clause 1: a next --wait 2 against a fake clock the test advances returns its idle answer only once the fake clock has passed 2 minutes [C7,#12761]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  let fake = 1_000_000;
  const began = fake, seen = [];
  let sleeps = 0;
  const clock = {
    now: () => { seen.push(fake); return fake; },
    sleep: async (wake, { deadline }) => { sleeps += 1; fake = Math.min(fake + FAKE_STEP_MS, Number.isFinite(deadline) ? Math.max(deadline, fake) : Infinity); },
  };
  const result = await drivenNext(box, box.web, clock, '--wait', '2');
  assert.equal(result.code, 4, `exit ${result.code}: ${result.err}`);
  assert.doesNotMatch(result.err, /\n\s+at [^\n]*\.js:\d+/u, `the wait ended in an error: ${result.err}`);
  assert.ok(fake >= began + FAKE_WAIT_MS, `the idle answer came with the fake clock at ${fake - began} ms, before 2 minutes`);
  assert.ok(fake - began < FAKE_WAIT_MS + FAKE_STEP_MS, `the fake clock ran on to ${fake - began} ms after the deadline`);
  assert.ok(seen.some(at => at - began > 0 && at - began < FAKE_WAIT_MS), 'the loop never read the clock before the deadline, so it did not wait on it');
  assert.ok(sleeps >= FAKE_WAIT_MS / FAKE_STEP_MS, `the wait slept through the clock ${sleeps} times, so it did not sleep through the seam`);
});

test('cli.io-commands-next-wait.fake-clock-wake: clause 1: a wake from a newly filed item returns at once whatever the fake clock says [C7,#12761]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const fake = 1_000_000;
  const clock = { now: () => fake, sleep: (wake, { after }) => wake.wait({ after }) };
  const waiting = drivenNext(box, box.web, clock, '--wait', '2');
  const board = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  while (!withFixtureBoard(board, open => open.db.prepare("SELECT 1 AS found FROM event WHERE event_kind = 'next-idle'").get())) await yieldEventLoop();
  const added = fixtureAdd(box.run, box.repo, 'web', 'Offered while a driven seat waits', '--specs', 'G1', '--criterion', 'renders', '--json');
  assert.equal(added.status ?? added.code, 0, `${added.out ?? added.stdout}\n${added.err ?? added.stderr}`);
  const item = JSON.parse(added.out ?? added.stdout).item;
  const result = await waiting;
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  assert.match(result.out, new RegExp(`#${item.item_id}\\b`, 'u'), `the wait did not hand over the offered item: ${result.out}`);
});
