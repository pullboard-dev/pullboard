/** A pull pilot under controller dispatch: only the items it picks queue a gate job; the rest, and all once it is off, take the controller path [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { boardQueueMode } from '../../../../packages/api/index.js';
import { jobQueueMode } from '../../../../packages/config/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';
import { closeBoard } from '../../../lib/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
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
async function submitController(box, id) {
  const claimed = (await box.runLocal(box.web, 'claim', String(id), '--json'));
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal(box.helpers.commitFile(box, folder, `web/${id}.txt`, `gate ${id}\n`, `feat(web): controller gate ${id} [G1]`).status, 0);
  const submitted = (await box.runLocal(folder, 'submit', String(id), '--json'));
  assert.doesNotMatch(submitted.out, /"queued": true|"gateJob"/u, `#${id} was not queued as a gate job`);
  assert.ok(submitted.code === 0 || /"code": "GATE_RED"/u.test(submitted.out), `#${id} ran the controller gate: ${submitted.out}${submitted.err}`);
}

test('clause 1: a pilot naming one item queues only that item; the others and every submit after it is off take the controller path [P7]', async t => {
  const box = await pullProject(t, 3, { gate: { runnerDispatch: 'controller' } });
  const [piloted, other, later] = box.ids;
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'controller', pullPilot: { items: [piloted, later] } } });
  const queued = submitOne(box, piloted);
  assert.equal(queued.document.queued, true, 'the piloted item queued its whole gate as one job');
  assert.deepEqual(gateJobs(box, piloted).map(row => [row.candidate, row.step]), [[queued.commit, 'offered']]);
  (await submitController(box, other));
  assert.deepEqual(gateJobs(box, other), [], 'no gate job row for the controller submit');
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'controller' } });
  (await submitController(box, later));
  assert.deepEqual(gateJobs(box, later), []);
});

test('clause 1: turning the pilot off drains its queued and leased gate jobs to their results, then the queue stops serving [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, two submits and one whole gate in a runner process.
async t => {
  const box = await pullProject(t, 2, { gate: { runnerDispatch: 'controller' } });
  const [queued, leased] = box.ids;
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'controller', pullPilot: { items: [queued, leased] } } });
  submitOne(box, queued);
  const leasedSubmit = submitOne(box, leased);
  // The board host reads this machine's settings, as the board API's jobs route does.
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const { board, url, call } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: boardQueueMode(current.db, jobQueueMode), trunk: () => box.repo }) });
  const builder = getItem(board, leased).item_owner;
  // The leased job: a runner holds it when the pilot is turned off.
  const { claim } = await call({ action: 'claim', runner: 'r-leased', capabilities: ['node22'], kinds: ['gate'] });
  assert.equal(claim.item, queued, 'the oldest job is leased first');
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'controller' } });
  assert.equal(boardQueueMode(board.db, jobQueueMode), 'pull', 'off, the queue still serves the jobs it holds');
  assert.equal((await call({ action: 'renew', job: claim.job, runner: 'r-leased', token: claim.token })).renewed, true, 'the lease renews');
  const red = await call({ action: 'receipt', job: claim.job, runner: 'r-leased', token: claim.token, receipt: { status: 1, gate: { green: false, error: 'fixture red' } } });
  assert.equal(red.applied.outcome, 'red', 'the leased job\'s receipt is applied');
  // The queued job: a runner takes and runs it after the pilot is off.
  assert.equal((await serveOnce(box, url, 'r-queued')).code, 0);
  assert.deepEqual([getItem(board, leased).item_status, getItem(board, leased).item_commit], ['submitted', leasedSubmit.commit], 'the queued job finished and its item went to review');
  assert.equal(getItem(board, queued).item_owner, builder, 'the red one is back with its builder, not stranded');
  assert.equal(boardQueueMode(board.db, jobQueueMode), 'controller', 'drained, the queue stops serving');
  assert.equal(jobsOf(board.db, { kind: 'gate' }).every(row => row.step === 'done'), true);
});
