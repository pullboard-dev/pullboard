/** Queued gate drivers that die, are stopped or never report keep the gate's record and the builder's claim [V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { driverRecord } from '../../../tests/fixtures/gate/driver.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import { openBoard } from '../../../../lib/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../../packages/jobs/index.js';
import { admitGateDrive } from '../../../../../packages/drive/index.js';
import { gateDriveJobId } from '../../../../../packages/drive/index.js';
import {
  document,
  fixture,
  state,
  waitJob,
} from '../../../tests/fixtures/submit/handoff.js';

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

/** The gate's drive job, with its saved steps and lease, read from the fixture's board file. */
function driveJob(box, job) {
  // @pullboard-board-file journey: read the drive job's persisted steps and lease after a driver stopped or died.
  const board = openBoard(box.boardFile);
  try { return jobView(board.db, gateDriveJobId(job)); } finally { board.db.close(); }
}

/** How many captured, running, collected and verdict steps the drive job has saved. */
function transitions(view) {
  return ['captured', 'running', 'collected', 'verdict'].map(name => view.steps.filter(step => step.name === name).length);
}

/** Count the lines a fixture gate wrote to one of its marker files. */
function lines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

/**
 * Admit a fresh driver to the gate's drive job and start it from the captured tools, as the dispatcher does.
 * Resolves with the driver's exit. `now` is the admission time, so a dead driver's lease can be read as lapsed.
 */
function resumeDriver(box, job, { now = Date.now() } = {}) {
  const owner = `test-driver:${job.id}:resumed`;
  // @pullboard-board-file journey: admit the next driver on the board, as the dispatcher writes it.
  const board = openBoard(box.boardFile);
  try { admitGateDrive(board.db, job.id, { owner, now }); } finally { board.db.close(); }
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  // The entry runs only under its real path, as the dispatcher starts it (the OS temp dir may be a symlink).
  // budget: the existing owned-driver hang ceiling; assertions concern exit and native results, not elapsed time.
  // Process-level: the real detached gate driver, run as its own process.
  return runFixtureChildAsync(process.execPath, [join(realpathSync(request.tools), 'apps/cli/src/io/gate/drive.js'), join(directory, 'request.json'), owner],
    { cwd: join(box.repo, '.git'), env: box.env, encoding: 'utf8', timeout: 120_000 });
}

test('clause 1: a driver stopped mid-check stops its check and leaves the job resumable, and a fresh driver finishes it with one terminal result [V4,H16,E18,C7]', async t => {
  const box = fixture(t);
  const queued = document(await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  await box.helpers.waitFor(() => existsSync(box.started) && checkPids(box).length > 0, 'the captured check is running', 120000); // budget: observed gate start ceiling, not a timing assertion.
  const job = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  const owner = driverRecord(box.boardFile, job.id);
  const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(owner.pid)], { encoding: 'utf8' }).trim());
  assert.equal(group, owner.pid, 'the driver the dispatcher started leads its own process group');
  process.kill(owner.pid, 'SIGTERM');
  await box.helpers.waitFor(() => gone(owner.pid), 'the stopped driver exits', 120000); // budget: owned driver exit ceiling, not a timing assertion.
  await box.helpers.waitFor(() => checkPids(box).length === 0, 'the stopped driver stops its check child', 120000); // budget: owned child stop ceiling, not a timing assertion.
  const stopped = state(box, box.id);
  assert.equal(stopped.job.id, job.id, 'the stopped job is not replaced');
  assert.equal(stopped.job.state, 'running', 'a stopped driver ends nothing: its job stays resumable');
  assert.equal(stopped.item.item_status, 'claimed');
  assert.equal(existsSync(join(directory, 'refusal.json')), false, 'a stopped driver records no refusal');
  assert.equal(existsSync(join(directory, 'source')), false, 'the stopped driver removed its disposable checkout');
  assert.equal(existsSync(join(directory, 'worker.json')), false, 'the driver is recorded on the board, never beside the hand-off');
  const saved = driveJob(box, job.id);
  assert.equal(saved.leaseOwner, null, 'the stopped driver freed its lease for the next driver');
  assert.deepEqual(transitions(saved), [1, 1, 0, 0], 'the job stays at its saved running step');
  writeFileSync(box.release, 'release\n');
  const resumed = await resumeDriver(box, job);
  assert.equal(resumed.status, 0, resumed.context);
  await waitJob(box, 'green');
  assert.equal(state(box, box.id).job.id, job.id, 'the same job finished');
  assert.deepEqual(transitions(driveJob(box, job.id)), [1, 1, 1, 1], 'the next driver resumed the same drive job from its saved step to one verdict');
  assert.equal(lines(box.started), 2, 'the stopped check and the resumed check each began once');
  assert.equal(lines(box.finished), 1, 'only the resumed check finished: the stopped one was stopped');
});

test('clause 1: a driver killed mid-check leaves its saved steps, and once its lease lapses a fresh driver resumes the same drive job to one verdict [C7]', async t => {
  const box = fixture(t);
  const queued = document(await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  await box.helpers.waitFor(() => existsSync(box.started), 'the captured check is running', 120000); // budget: observed gate start ceiling, not a timing assertion.
  const job = state(box, box.id).job;
  const owner = driverRecord(box.boardFile, job.id);
  process.kill(-owner.pid, 'SIGKILL');
  await box.helpers.waitFor(() => gone(owner.pid), 'the killed driver is gone', 120000); // budget: kill ceiling, not a timing assertion.
  assert.equal(state(box, box.id).job.state, 'running', 'the killed driver ended nothing');
  const saved = driveJob(box, job.id);
  assert.equal(saved.leaseOwner, owner.owner, 'a killed driver keeps its lease until it lapses');
  assert.deepEqual(transitions(saved), [1, 1, 0, 0], 'the job keeps its saved running step');
  assert.throws(() => {
    // @pullboard-board-file journey: a second admission while the dead driver's lease is live.
    const board = openBoard(box.boardFile);
    try { admitGateDrive(board.db, job.id, { owner: `test-driver:${job.id}:early` }); } finally { board.db.close(); }
  }, { code: 'GATE_DRIVE_LEASED' }, 'no second driver is admitted while the lease is live');
  writeFileSync(box.release, 'release\n');
  const resumed = await resumeDriver(box, job, { now: Date.now() + LEASE_MS + 1000 });
  assert.equal(resumed.status, 0, resumed.context);
  await waitJob(box, 'green');
  assert.equal(state(box, box.id).job.id, job.id, 'the same job finished');
  assert.deepEqual(transitions(driveJob(box, job.id)), [1, 1, 1, 1], 'the next driver resumed the same drive job from its saved step to one verdict');
});
