/** With runs_store on, landing offers go through queueRun: the runs file holds the job and the board one queued run row; off, the board's job rows are as before [B2,P7,#9003]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellSandbox } from '../../../store/tests/fixtures/cell.js';
import { boardRun } from '../../../store/index.js';
import { RUNS_STORE_KEY } from '../../../store/index.js';
import { jobView } from '../../../jobs/index.js';
import { offerLandingJob } from '../../index.js';
import { reofferLandingJob } from '../../index.js';
import { queueFor } from '../../index.js';

const COMMIT = 'a'.repeat(40);
const CONFIG = { trunk: { remote: '/trunk.git' } };
const item = id => ({ id, commit: COMMIT, ref: `refs/pullboard/land/${id}` });

/** A file board with the runs_store flag set as asked. */
function boardWith(t, flag) {
  const board = cellBoard(t, join(cellSandbox(t).dir, 'board.sqlite'), undefined, { real: true });
  if (flag) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  return board;
}

/** The same land job with the flag on or off: the offered step as it was written, and where it was written. */
function offerOne(t, flag) {
  const board = boardWith(t, flag);
  const queue = queueFor(board, 'coordinator');
  t.after(() => queue?.runs.db.close());
  const job = offerLandingJob(board.db, { items: [item(9003)], expect: 'b'.repeat(40), config: CONFIG, ...(queue ? { queue } : {}) });
  return { board, queue, job };
}

test('api.landing-queue.runs-store-offerlandingjob-reofferlandingjob-offer: clause 1: with runs_store on, offerLandingJob and reofferLandingJob offer through queueRun and the board holds a queued run row per offer [B2,P7]', t => {
  const { board, queue, job } = offerOne(t, true);
  assert.equal(boardRun(board.db, job.id).run_state, 'queued', 'the board holds the run');
  assert.equal(boardRun(board.db, job.id).run_kind, 'land');
  assert.equal(jobView(queue.runs.db, job.id).step, 'offered', 'the runs file holds the offered job');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM job').get().n, 0, 'the board writes no job row');
  const again = reofferLandingJob(board.db, job.id, { queue });
  assert.equal(again.id, `${job.id}~r1`);
  assert.equal(boardRun(board.db, again.id).run_state, 'queued', 'the second offer has its own run row');
  assert.equal(jobView(queue.runs.db, again.id).step, 'offered');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 2);
  assert.equal(offerLandingJob(board.db, { items: [item(9003)], expect: 'b'.repeat(40), config: CONFIG, queue }).id, job.id, 'the same landing reuses its job');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 2, 'a retried offer writes no second run');
});

test('api.landing-queue.runs-store-off-both-offers: clause 2: with runs_store off, both offers write the same board job rows as on main and no run row [B2,P7]', t => {
  const { board, queue, job } = offerOne(t, false);
  assert.equal(queue, null, 'the flag is off, so there is no queue');
  assert.equal(jobView(board.db, job.id).step, 'offered');
  const again = reofferLandingJob(board.db, job.id, { queue });
  assert.equal(jobView(board.db, again.id).step, 'offered');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 0);
});

/** A landing job's items keep each item's pace, steady when none is named, and refuse any other pace [C7]. */
test('api.landing-pace.items-carry-pace: offerLandingJob keeps each landed item\'s pace in the payload, steady by default, and refuses any other pace [C7]', t => {
  const board = boardWith(t, false);
  const job = offerLandingJob(board.db, { items: [{ ...item(9101), pace: 'sprint' }, { ...item(9102), pace: 'strict' }, { ...item(9103), pace: 'steady' }, item(9104)], expect: 'b'.repeat(40), config: CONFIG });
  const view = jobView(board.db, job.id);
  const offered = view.steps.find(step => step.name === 'offered').payload.payload;
  assert.deepEqual(offered.items.map(entry => entry.pace), ['sprint', 'strict', 'steady', 'steady']);
  assert.throws(() => offerLandingJob(board.db, { items: [{ ...item(9105), pace: 'turbo' }], expect: 'b'.repeat(40), config: CONFIG }), { code: 'LANDING_ITEMS' });
});

/** A sprint plan rides the landing payload only for a sprint item, with exactly its three fields, and a malformed plan is refused [C7,#12409]. */
test('api.landing-pace.sprint-plan-rides-the-payload: offerLandingJob puts payload.sprint on a job with a sprint item, leaves it off otherwise, and refuses a malformed plan [C7]', t => {
  const board = boardWith(t, false);
  const plan = { static: ['node', 'check.js'], testCommand: ['node', '--test'], testFiles: '\\.test\\.js$' };
  const payloadOf = job => jobView(board.db, job.id).steps.find(step => step.name === 'offered').payload.payload;
  const expect = 'b'.repeat(40);
  const sprinted = payloadOf(offerLandingJob(board.db, { items: [{ ...item(9201), pace: 'sprint' }], expect, config: CONFIG, sprint: { ...plan, extra: 1 } }));
  assert.deepEqual(sprinted.sprint, plan);
  assert.deepEqual(payloadOf(offerLandingJob(board.db, { items: [{ ...item(9202), pace: 'sprint' }], expect, config: CONFIG, sprint: { ...plan, static: null } })).sprint, { ...plan, static: null });
  assert.equal('sprint' in payloadOf(offerLandingJob(board.db, { items: [{ ...item(9203), pace: 'sprint' }], expect, config: CONFIG })), false);
  assert.equal('sprint' in payloadOf(offerLandingJob(board.db, { items: [item(9204), { ...item(9205), pace: 'strict' }], expect, config: CONFIG, sprint: plan })), false);
  for (const bad of [{}, { ...plan, static: 'node' }, { ...plan, static: [] }, { ...plan, testCommand: [] }, { ...plan, testCommand: 'node' }, { ...plan, testFiles: ['x'] }, { static: plan.static, testCommand: plan.testCommand }, 'sprint', []]) {
    assert.throws(() => offerLandingJob(board.db, { items: [{ ...item(9206), pace: 'sprint' }], expect, config: CONFIG, sprint: bad }), { code: 'LANDING_SPRINT' });
  }
});
