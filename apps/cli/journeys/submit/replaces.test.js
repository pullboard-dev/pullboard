/** A new head's submit queues its own pulled gate beside the item's earlier one, which can no longer land the item [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { removeSandboxes } from '../../tests/fixtures/submit/handoff.js';
import { withBoardFile } from '../../tests/fixtures/submit/handoff.js';
import { stopFixtureLocalRunner } from '../../tests/fixtures/runner/local-stop.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { openBoard } from '../../../lib/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** The item's gate jobs, oldest first, read from the real board the CLI and the local runner wrote. */
function gateJobs(box, id) {
  return withBoardFile(box, db => jobsOf(db, { kind: 'gate', item: id }).map(job => ({ id: job.id, candidate: job.candidate, step: job.step })));
}

/** The item row, read without writing anything. */
function itemOf(box, id) {
  // @pullboard-board-file journey: observe the item row the board applied a gate receipt to.
  const board = openBoard(box.boardFile);
  try { return getItem(board, id); }
  finally { board.db.close(); }
}

/** Quote a private fixture path for the configured shell command. */
function word(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** A native project whose gate holds while the candidate says "hold", until released; its submits return without settling. */
async function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const release = join(box.dir, 'release'), started = join(box.dir, 'started');
  const script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const value = fs.existsSync('web/snapshot.txt') ? fs.readFileSync('web/snapshot.txt', 'utf8').trim() : 'base';",
    "if (value === 'hold') {",
    ` fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));`,
    ' const deadline = Date.now() + 120000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    '}',
  ].join('\n'));
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const id = document((await fixtureAdd(box.runLocal, box.repo, 'web', 'Replaced running gate', '--specs', 'G1',
    '--criterion', 'A new head replaces a running gate.', '--check', `${word(process.execPath)} ${word(script)}`, '--wait', '--json'))).item.item_id;
  document((await box.runLocal(box.web, 'claim', String(id), '--json')));
  // The first gate holds on its release file while the journey submits again, so no submit waits for the queue to settle.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => gateJobs(box, id).every(job => job.step === 'done'), 'every gate job finished', 120000); // budget: cleanup ceiling, no timing assertion.
    stopFixtureLocalRunner(isolated.env.PULLBOARD_MACHINE_HOME);
    await removeSandboxes(helpers);
  });
  return { ...box, helpers, id, started, release };
}

test('submitting head B while head A gates queues B its own gate, and A can no longer land the item [C7,V4]', async t => {
  const box = await fixture(t);
  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'hold\n', 'feat(web): held candidate [G1]').status, 0);
  const first = document(await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(first.queued, true);
  await box.helpers.waitFor(() => gateJobs(box, box.id).some(job => job.step === 'claimed') && existsSync(box.started), 'the gate is running', 120000); // budget: real runner start ceiling, no timing assertion.
  const [held] = gateJobs(box, box.id);
  assert.equal(held.candidate, first.commit, 'the running gate judges head A');

  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'pass\n', 'feat(web): next candidate [G1]').status, 0);
  const next = await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json');
  assert.doesNotMatch(next.out + next.err, /SUBMIT_HANDOFF_PENDING/u, 'a new head is never refused behind the old gate');
  const second = document(next);
  assert.equal(second.queued, true, 'head B queued its own gate');
  const jobs = gateJobs(box, box.id);
  assert.equal(jobs.length, 2, 'A keeps its job; B has another');
  assert.notEqual(jobs[1].id, held.id, 'B has its own job');
  assert.equal(jobs[1].candidate, box.git(box.web, 'rev-parse', 'HEAD'), 'the queued job is head B');

  // Nothing stops A's held gate on the runner; its receipt just cannot move the item once the item is at head B (e377a352b5, the handoff worker that stopped it, is deleted).
  writeFileSync(box.release, 'release\n');
  const settled = await settledGateJob(box, box.id);
  assert.equal(settled.gate.green, true);
  await box.helpers.waitFor(() => gateJobs(box, box.id).every(job => job.step === 'done'), 'both gate jobs finished', 120000); // budget: real gate ceiling, no timing assertion.
  const item = itemOf(box, box.id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_commit, jobs[1].candidate, 'the item is submitted at head B');
});
