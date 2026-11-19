/** @pullboard-test-input apps/cli/src/io/commands/next.js */
/** A real next --wait on a board other seats keep writing: the CPU it burns is measured and reported, with no threshold [C7,#11794]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { startBoardWriter } from '../../../fixtures/board-writer.js';
import { createFixtureWorktree } from '../../../fixtures/testkit.js';

const WAIT_MINUTES = '0.1';

/** Run the production next command in this process and answer its result with the process CPU seconds and wall seconds it took. */
async function measured(box, cwd, ...args) {
  const cpuBefore = process.cpuUsage(), began = Date.now();
  const result = await box.inProcess(cwd, 'next', ...args);
  const used = process.cpuUsage(cpuBefore);
  return { ...result, cpu: (used.user + used.system) / 1e6, seconds: (Date.now() - began) / 1000 };
}

test('cli.io-commands-next-wait.busy-board-cpu: clause 1: a real next --wait on a fixture board with nothing to take, while a separate process writes the board every 50 ms for 5 s, returns its idle answer without an error and reports the process CPU seconds it used [C7,#11794]', async t => {
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
  await measured(box, seat);
  const plain = await measured(box, seat);
  const writing = startBoardWriter(join(repo, '.git', 'pullboard', 'board.sqlite'));
  const waiting = await measured(box, seat, '--wait', WAIT_MINUTES);
  const wrote = await writing;
  assert.equal(wrote.code, 0, wrote.err);
  assert.doesNotMatch(waiting.err, /\n\s+at [^\n]*\.js:\d+/u, `the wait ended in an error: ${waiting.err}`);
  assert.ok(waiting.code === 0 || waiting.code === 1, `exit ${waiting.code}: ${waiting.err}`);
  assert.ok(waiting.seconds >= 5, `the wait returned after ${waiting.seconds} s, so it did not wait under the writes: ${waiting.err}`);
  const figure = Math.round((waiting.cpu - plain.cpu) * 100) / 100;
  t.diagnostic(`the wait ran ${waiting.seconds} s, exit ${waiting.code}: ${(waiting.out + waiting.err).replace(/\s+/gu, ' ').slice(0, 300)}`);
  t.diagnostic(`next --wait under board writes: process CPU ${waiting.cpu} s in all, ${plain.cpu} s for one plain next, so ${figure} s for the wait over ${Number(WAIT_MINUTES) * 60} s of writes`);
  console.log(`BUSY_BOARD_WAIT_CPU_SECONDS ${figure} (total ${waiting.cpu}, plain next ${plain.cpu})`);
});
