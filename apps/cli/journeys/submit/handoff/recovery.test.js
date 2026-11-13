/** A pulled gate job whose runner is stopped or dies mid-check keeps the gate's record and the builder's claim [V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../lib/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import {
  document,
  fixture,
  state,
} from '../../../tests/fixtures/submit/handoff.js';

const BIN = join(import.meta.dirname, '../../../pullboard.js');

/** The pids of this fixture's own frozen check processes that are still running, read from the process table. */
function checkPids(box) {
  try { return execFileSync('pgrep', ['-f', join(box.dir, 'gate.cjs')], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); }
  catch (error) { if (error.status === 1) return []; throw error; }
}

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** The item's newest gate job, with its steps and lease, read from the fixture's board file. */
function gateJob(box) {
  // @pullboard-board-file journey: read the pulled gate job's persisted steps and lease after its runner stopped or died.
  const board = openBoard(box.boardFile);
  try { const job = jobsOf(board.db, { kind: 'gate', item: box.id }).at(-1); return job ? jobView(board.db, job.id) : null; }
  finally { board.db.close(); }
}

/** How many claims and receipts the job has recorded: one claim per runner that took it, one receipt per terminal result. */
function transitions(view) {
  return ['claimed', 'receipt'].map(name => view.steps.filter(step => step.name === name).length);
}

/** Count the lines a fixture gate wrote to one of its marker files. */
function lines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

/** The pid of the machine's local runner, which holds the gate job's lease under pull, from its own state file. */
function runnerPid(box) {
  return JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'state.json'), 'utf8')).pid;
}

/**
 * Start a fresh local runner for the fixture's machine, as the next pull submit would, and stop it when the test ends.
 * Process-level: the real `pullboard runner local`, run as its own process with the machine's settings only.
 */
function freshRunner(t, box) {
  const env = Object.fromEntries(Object.entries(box.env).filter(([key]) => !key.startsWith('PULLBOARD_') || ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].includes(key)));
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [BIN, 'runner', 'local'], { cwd: box.repo, env, detached: true, stdio: 'ignore' });
  child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  return child.pid;
}

/** Submit the captured item and wait until its runner has the gate job and the captured check is running. */
async function runningGate(box) {
  const queued = document(await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  await box.helpers.waitFor(() => existsSync(box.started) && checkPids(box).length > 0, 'the captured check is running', 120000); // budget: observed gate start ceiling, not a timing assertion.
  const job = gateJob(box);
  assert.equal(job.step, 'claimed', 'a runner holds the gate job');
  return job;
}

/** Wait until the board records the gate job's receipt and the item is submitted for review. */
async function submitted(box) {
  await box.helpers.waitFor(() => state(box, box.id).item.item_status === 'submitted', 'the resumed gate job submits the item', 180000); // budget: pulled gate settle ceiling, not a timing assertion.
}

test('clause 1: a runner stopped mid-check stops its check and hands back the gate job lease, and a fresh runner finishes the same job with one terminal result [V4,H16,E18,C7]', async t => {
  const box = fixture(t);
  const job = await runningGate(box);
  const pid = runnerPid(box);
  process.kill(pid, 'SIGTERM');
  await box.helpers.waitFor(() => gone(pid), 'the stopped runner exits', 120000); // budget: runner stop ceiling, not a timing assertion.
  await box.helpers.waitFor(() => checkPids(box).length === 0, 'the stopped runner stops its check child', 120000); // budget: owned child stop ceiling, not a timing assertion.
  const stopped = gateJob(box);
  assert.equal(stopped.id, job.id, 'the stopped job is not replaced');
  assert.equal(stopped.step, 'claimed', 'a stopped runner ends nothing: its job stays resumable');
  assert.equal(stopped.leaseOwner, null, 'the stopped runner freed its lease for the next runner');
  assert.deepEqual(transitions(stopped), [1, 0], 'the job keeps its one claim and records no result');
  assert.equal(state(box, box.id).item.item_status, 'claimed', 'the builder keeps the claim');
  writeFileSync(box.release, 'release\n');
  freshRunner(t, box);
  await submitted(box);
  const finished = gateJob(box);
  assert.equal(finished.id, job.id, 'the same job finished');
  assert.equal(finished.step, 'done');
  assert.deepEqual(transitions(finished), [2, 1], 'the fresh runner took the same job again and posted one terminal result');
  assert.equal(lines(box.started), 2, 'the stopped check and the resumed check each began once');
  assert.equal(lines(box.finished), 1, 'only the resumed check finished: the stopped one was stopped');
});

test('clause 1: a runner killed mid-check keeps the gate job lease until it lapses, and then a fresh runner takes the same job to one verdict [C7]', async t => {
  const box = fixture(t);
  const job = await runningGate(box);
  const pid = runnerPid(box), checks = checkPids(box);
  const holder = job.leaseOwner;
  // The machine dies: the runner and its detached check group go at once, with no chance to hand anything back.
  process.kill(pid, 'SIGKILL');
  for (const check of checks) { try { process.kill(-check, 'SIGKILL'); } catch { try { process.kill(check, 'SIGKILL'); } catch { /* already gone */ } } }
  await box.helpers.waitFor(() => gone(pid) && checkPids(box).length === 0, 'the killed runner and its check are gone', 120000); // budget: kill ceiling, not a timing assertion.
  const killed = gateJob(box);
  assert.equal(killed.step, 'claimed', 'the killed runner ended nothing');
  assert.equal(killed.leaseOwner, holder, 'a killed runner keeps its lease until it lapses');
  assert.ok(killed.leaseUntil > Date.now(), 'the lease is still live');
  const capabilities = killed.steps.find(step => step.name === 'claimed').payload.capabilities;
  // @pullboard-board-file journey: a second runner asks the board's queue for work while the dead runner's lease is live.
  let board = openBoard(box.boardFile);
  try {
    const answer = jobQueueCall(board.db, { action: 'claim', runner: 'second-runner', capabilities }, { mode: 'pull' });
    assert.equal(answer.claim, null, 'no second runner takes the job while the lease is live: ' + JSON.stringify(answer));
  } finally { board.db.close(); }
  // @pullboard-board-file journey: the lease's two minutes pass; the row reads as it would once they had.
  board = openBoard(box.boardFile);
  try { board.db.prepare('UPDATE job SET job_lease_until = ? WHERE job_id = ?').run(Date.now() - 1, job.id); } finally { board.db.close(); }
  writeFileSync(box.release, 'release\n');
  freshRunner(t, box);
  await submitted(box);
  const finished = gateJob(box);
  assert.equal(finished.id, job.id, 'the same job finished');
  assert.equal(finished.step, 'done');
  assert.deepEqual(transitions(finished), [2, 1], 'the fresh runner took the lapsed job and posted one terminal result');
});
