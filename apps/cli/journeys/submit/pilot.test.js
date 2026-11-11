/** A pull pilot under controller dispatch: only the items it picks queue a gate job; the rest, and all once it is off, take the controller path [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';
import { closeBoard } from '../../../lib/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

/** The gate job rows the board holds for one item. */
function gateJobs(box, item) {
  // @pullboard-board-file journey: reads the job rows the real CLI submit wrote.
  const board = openKitBoard(box.boardFile, undefined, { gitRoot: box.repo });
  try { return jobsOf(board.db, { kind: 'gate', item }); } finally { closeBoard(board); }
}

/**
 * Claim, commit and submit one item that should take the controller path. The fixture's main has none of the repo's
 * static baselines, so the controller gate may stop red at its preflight; either way it ran here, never as a job row.
 */
function submitController(box, id) {
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal(box.helpers.commitFile(box, folder, `web/${id}.txt`, `gate ${id}\n`, `feat(web): controller gate ${id} [G1]`).status, 0);
  const submitted = box.run(folder, 'submit', String(id), '--json');
  assert.doesNotMatch(submitted.out, /"queued": true|"gateJob"/u, `#${id} was not queued as a gate job`);
  assert.ok(submitted.code === 0 || /"code": "GATE_RED"/u.test(submitted.out), `#${id} ran the controller gate: ${submitted.out}${submitted.err}`);
}

test('clause 1: a pilot naming one item queues only that item; the others and every submit after it is off take the controller path [P7]', async t => {
  const box = await pullProject(t, 3, { gate: { runnerDispatch: 'controller' } });
  const [piloted, other, later] = box.ids;
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller', pullPilot: { items: [piloted, later] } } });
  const queued = submitOne(box, piloted);
  assert.equal(queued.document.queued, true, 'the piloted item queued its whole gate as one job');
  assert.deepEqual(gateJobs(box, piloted).map(row => [row.candidate, row.step]), [[queued.commit, 'offered']]);
  submitController(box, other);
  assert.deepEqual(gateJobs(box, other), [], 'no gate job row for the controller submit');
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  submitController(box, later);
  assert.deepEqual(gateJobs(box, later), []);
});
