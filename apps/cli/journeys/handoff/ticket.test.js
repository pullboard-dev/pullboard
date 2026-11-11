/** A queued gate whose launch ticket is lost ends on one health sweep, so its claim stops holding the item [C7,#3153]. */
import { handoffRecord } from '../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import {
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  getItem,
  submitHandoff,
} from '../../../../packages/store/index.js';
import { queuedWorkerRecord } from '../../src/io/submit/handoff.js';
import {
  HANDOFF_DISPATCHER_RESOURCE,
  handoffQueueDirectory,
  takeResource,
} from '../../../../packages/resources/index.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read or change the fixture's real SQLite board; a change stands in only for time passing. */
function onBoard(box, work) {
  // @pullboard-board-file journey: age the fixture's own queued record, as two minutes passing would.
  const board = openBoard(box.boardFile);
  try { return work(board); } finally { board.db.close(); }
}

/** Run one health sweep as the coordinator, from the main checkout. */
function sweep(box) {
  const run = box.run(box.repo, 'sentinel', 'run', '--health-only');
  assert.equal(run.code, 0, `${run.err}\n${run.out}`);
}

/** Run `work` with this process's machine home set to the fixture's, so its resources are the fixture's own. */
async function inMachineHome(box, work) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try { return await work(); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** Set the job's queue time `ms` in the past, keeping every other recorded field. */
function ageJob(box, id, ms) {
  onBoard(box, board => {
    const job = handoffRecord(board.db, id);
    job.at = new Date(Date.now() - ms).toISOString();
    // The gate job holds the record submitHandoff() reads (#3474, #3476).
    recordSubmitHandoff(board.db, id, job);
  });
}

test('clause 1: a queued gate with no worker and no ticket ends on one sweep only past its grace, and its lapsed claim opens [C7,#3153]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const box = helpers.project('true', isolated);
  // The test holds the one dispatcher place, so no worker starts and the job stays queued behind its ticket.
  const dispatcher = await inMachineHome(box, () => takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'lost-ticket-fixture' }));
  t.after(() => { dispatcher.release(); helpers.cleanup(); });
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Lost ticket handoff', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'A lost queued launch ends within one sweep.', '--check', 'true', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/lost.txt', 'lost\n', 'feat(web): lost ticket candidate [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(id), '--no-next', '--json')).queued, true);
  const job = onBoard(box, board => submitHandoff(board, id));
  assert.equal(job.state, 'queued');
  const tickets = await inMachineHome(box, () => readdirSync(handoffQueueDirectory()).filter(name => name.includes(job.id) && !name.startsWith('.')));
  assert.equal(tickets.length, 1, 'the submit left one place in line');

  ageJob(box, id, 3 * 60_000);
  sweep(box);
  assert.equal(onBoard(box, board => submitHandoff(board, id)).state, 'queued', 'a job still in line is left queued');

  await inMachineHome(box, () => rmSync(join(handoffQueueDirectory(), tickets[0])));
  ageJob(box, id, 30_000);
  sweep(box);
  assert.equal(onBoard(box, board => submitHandoff(board, id)).state, 'queued', 'a lost ticket under the grace is left queued');

  ageJob(box, id, 3 * 60_000);
  sweep(box);
  // The sweep ends the lost launch as infrastructure, then recoverInfrastructureHandoffs retries it under a new job id (3810cc1a6d).
  const ended = onBoard(box, board => submitHandoff(board, id));
  assert.notEqual(ended.id, job.id, 'the retried job replaces the lost launch on the board');
  assert.ok(['queued', 'infrastructure'].includes(ended.state), 'the retry is queued, or ended as infrastructure when its launch failed');
  // Each retry holds the claim while queued, so lose every retry's place in line too, until the two-retry budget is spent.
  let last = ended;
  for (let round = 0; round < 3 && last.state === 'queued'; round++) {
    const names = await inMachineHome(box, () => readdirSync(handoffQueueDirectory()).filter(name => name.includes(last.id) && !name.startsWith('.')));
    await inMachineHome(box, () => { for (const name of names) rmSync(join(handoffQueueDirectory(), name)); });
    ageJob(box, id, 3 * 60_000);
    sweep(box);
    last = onBoard(box, board => submitHandoff(board, id));
  }
  assert.equal(last.state, 'infrastructure', 'once the retries are spent the lost launch ends as infrastructure');
  assert.equal(last.error?.code, 'SUBMIT_HANDOFF_DEAD');

  // The claim lease lapsing, as it does once its two hours pass, now opens the item instead of holding it.
  onBoard(box, board => board.db.prepare('UPDATE item SET item_lease_until=? WHERE item_id=?').run(new Date(Date.now() - 60_000).toISOString(), id));
  assert.equal(onBoard(box, board => getItem(board, id)).item_status, 'open', 'the lapsed claim reads open');
  const other = join(box.dir, 'other-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/other-seat', other, 'main');
  // The item routes strong, so the other seat joins on the strong route.
  assert.equal(joinFixtureSeat(box, other, 'web').code, 0);
  const claimed = box.run(other, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
});

test('a launch that publishes its worker while the sweep checks its ticket is never ended [C7,#3153]', () => {
  const job = { id: 'race-job', state: 'queued', at: new Date(Date.now() - 3 * 60_000).toISOString() };
  const live = { version: 1, job: job.id, pid: process.pid, started: 'fixture-start', relaunches: 0 };
  let worker = null;
  // The dispatcher's order: admit the driver on the board, then remove the ticket; here both happen inside the ticket check.
  const waiting = () => { worker = live; return false; };
  assert.deepEqual(queuedWorkerRecord(job, { readWorker: () => worker, waiting }), live, 'the second read finds the live worker');
  const lost = queuedWorkerRecord(job, { readWorker: () => null, waiting: () => false });
  assert.equal(lost.unstarted.code, 'HANDOFF_TICKET_LOST', 'with no worker after the ticket check the launch is lost');
  assert.equal(queuedWorkerRecord({ ...job, at: new Date().toISOString() }, { readWorker: () => null, waiting: () => false }), null, 'under the grace it is left alone');
});
