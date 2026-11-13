/** A plain project, one with no Pullboard packages of its own, gets its pulled gate settled on default settings with no registered runner, and the tour prints its sha [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';

/** Read the board through a short connection, as another process reads a board the local runner writes. */
function read(box, work) {
  // @pullboard-board-file journey: the test reads the board the local runner writes, as any second process would.
  const board = openKitBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try { return work(board); } finally { closeBoard(board); }
}

/** Wait for a board condition, probed again whenever the local runner's folder changes (a log line per claim and receipt, a heartbeat every 5 s). */
function until(box, check) {
  return new Promise(done => {
    let watcher = null;
    const probe = () => {
      let value = null;
      try { value = read(box, check); } catch { /* the runner holds the board lock; the next change probes again */ }
      if (!value) return false;
      watcher?.close();
      done(value);
      return true;
    };
    if (!probe()) watcher = watch(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner'), probe);
  });
}

test('clause 1: a plain project on default settings with no runner settles its pulled gate green [C7]', { timeout: 240_000 }, // budget: hang ceiling for init, one local runner start and one pulled gate.
async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = { ...helpers.project('true', helpers.sandbox()), helpers };
  assert.equal(existsSync(join(box.repo, 'packages')), false, 'the project carries no Pullboard packages');
  // Default dispatch (pull) and the default local runner; only the load share is raised, since test hosts run loaded and the share only delays a claim.
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localLoadShare: 1000 } });
  const added = fixtureAdd(box.run, box.repo, 'web', 'Plain gate', '--specs', 'G1', '--criterion', 'The plain gate settles.', '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const one = submitOne(box, id);
  assert.equal(one.document.queued, true, JSON.stringify(one.document));
  const pid = one.document.localRunner?.pid;
  t.after(() => { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  const job = await until(box, board => jobsOf(board.db, { kind: 'gate', item: id }).find(row => row.step === 'done'));
  const receipt = job.steps.find(step => step.name === 'receipt').payload.receipt;
  const log = join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'runner.log');
  assert.equal(receipt.gate.green, true, `${JSON.stringify(receipt.gate).slice(0, 3000)}\n${existsSync(log) ? readFileSync(log, 'utf8').slice(-2000) : ''}`);
  assert.equal(read(box, board => getItem(board, id).item_status), 'submitted');
});

test('clause 2: pullboard tour on default settings prints its at <sha> line [C7]', { timeout: 180_000 }, // budget: hang ceiling for the whole scripted tour.
async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  // The tour makes its own throwaway homes, so the box's controller pin never reaches it: it gates on the pull default.
  const shown = await runCliInProcess(['tour'], { cwd: box.dir, env: { ...box.env, TMPDIR: box.dir } });
  assert.equal(shown.code, 0, `${shown.out}${shown.err}`);
  assert.match(shown.out, /submitted #1 at [0-9a-f]{12}/u);
});
