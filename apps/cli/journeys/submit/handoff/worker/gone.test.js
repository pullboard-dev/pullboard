/** A queued or running hand-off whose driver is gone is requeued by the dispatcher's drain, never shown in the gate for hours [C7,#3221]. */
import { handoffRecord } from '../../../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../../lib/index.js';
import { recordSubmitHandoff } from '../../../../../../packages/jobs/index.js';
import {
  gateDriveJobId,
  readGateDrive,
} from '../../../../../../packages/drive/index.js';
import {
  fixture,
  state,
} from '../../../../tests/fixtures/submit/handoff.js';

/** Age the queued or running job's recorded start by `ms`, standing in for time passing on the fixture's own board. */
function ageHandoff(box, id, ms) {
  // @pullboard-board-file journey: age the fixture's own hand-off record, as ten minutes passing would.
  const board = openBoard(box.boardFile);
  try {
    const job = handoffRecord(board.db, id);
    job.at = new Date(Date.now() - ms).toISOString();
    if (job.startedAt) job.startedAt = job.at;
    // The gate job holds the record submitHandoff() reads (#3474, #3476).
    recordSubmitHandoff(board.db, id, job);
  } finally { board.db.close(); }
}

/** The gate's driver record on the fixture's own board: its drive job, as the dispatcher admitted it. */
function driverRecord(box, job) {
  // @pullboard-board-file journey: read the drive job the separate dispatcher wrote to the fixture's own board.
  const board = openBoard(box.boardFile);
  try { return readGateDrive(board.db, job); } finally { board.db.close(); }
}

/** Remove the gate's driver record, standing in for a gate with no driver record and no place in line (#3221). */
function forgetDriver(box, job) {
  // @pullboard-board-file journey: drop the fixture's own drive job rows, as a lost driver record would leave them.
  const board = openBoard(box.boardFile);
  try {
    board.db.prepare('DELETE FROM job_step WHERE job_step_job = ?').run(gateDriveJobId(job));
    board.db.prepare('DELETE FROM job WHERE job_id = ?').run(gateDriveJobId(job));
  } finally { board.db.close(); }
}

/** Count the item's recorded hand-off events that moved a job into `jobState`. */
function handoffEvents(box, id, jobState) {
  // @pullboard-board-file journey: count the events the separate dispatcher sweep wrote to the fixture's own board.
  const board = openBoard(box.boardFile);
  try {
    return board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit-handoff'").all(id)
      .filter(row => JSON.parse(row.event_detail).state === jobState).length;
  } finally { board.db.close(); }
}

/**
 * Run one dispatcher drain on the fixture's repository and return what it printed.
 * Why: the drain's sweep reports a hand-off it could not end on stderr only, so a failed case quotes it.
 */
async function drainOnce(box, source, swept = () => true) {
  // The submit's own dispatcher can hold the one dispatcher place, so a drain beside it defers and sweeps nothing:
  // drain again until the sweep's effect is observable on the board, never until one named process has ended.
  let run;
  await box.helpers.waitFor(() => { // budget: hang ceiling for the submit dispatcher to leave, not a timing assertion.
    run = spawnSync(process.execPath, [join(source, 'apps/lib/src/io/handoff/dispatcher.js')], { cwd: join(box.repo, '.git'), env: box.env, encoding: 'utf8' });
    assert.equal(run.status, 0, `the drain exits 0\n${run.stdout}${run.stderr}`);
    return swept();
  }, 'a drain whose sweep shows on the board', 120000).catch(() => { /* the case's own assertion quotes the log */ });
  // The dispatcher logs a failed sweep here, not on its output; quote it so a missed requeue names its cause.
  let logged = '';
  try { logged = readFileSync(join(box.dir, 'machine-home', 'handoff-queue', 'dispatcher.log'), 'utf8'); } catch { /* no log: nothing failed */ }
  // Name every dispatcher log under the fixture, and the drive record the sweep judges, so a missed requeue shows its cause.
  const found = spawnSync('find', [box.dir, '-name', 'dispatcher.log'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  for (const file of found) { try { logged += `\n[${file}]\n${readFileSync(file, 'utf8')}`; } catch { /* unreadable log */ } }
  return `${run.stdout}${run.stderr}${logged}`;
}

test('clause 1: a drain requeues a gone-worker hand-off once as worker-gone, and clause 2: show names the requeue and its reason [C7]', async t => {
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '../../../../../..');
  const tools = join(box.dir, 'silent-tools');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const worker = join(tools, 'apps/cli/src/io/gate/drive.js');
  // Only the launched gate driver process exits, before it drives anything.
  writeFileSync(worker, `if (process.argv[1]?.endsWith('gate-drive-worker.js')) process.exit(0);\n` + readFileSync(worker, 'utf8'));
  const subOut = execFileSync(process.execPath, [join(tools, 'apps/cli/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(JSON.parse(subOut).queued, true);
  const first = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', first.id);
  await box.helpers.waitFor(() => driverRecord(box, first.id)?.pid > 0, 'the dispatcher recording its driver', 120000); // budget: hang ceiling for observed dispatcher progress.
  const owner = driverRecord(box, first.id);
  assert.equal(existsSync(join(directory, 'worker.json')), false, 'the driver is recorded on the board, never beside the hand-off');
  await box.helpers.waitFor(() => { // budget: owned process exit ceiling, not a timing assertion.
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, 'actual first worker exit', 120000);
  forgetDriver(box, first.id);
  const drain = () => drainOnce(box, source);

  ageHandoff(box, box.id, 11 * 60_000);
  const swept = await drainOnce(box, source, () => state(box, box.id).job.id !== first.id);
  const requeued = state(box, box.id);
  assert.notEqual(requeued.job.id, first.id, `clause 1: a successor job carries the same source\n${swept}\n${JSON.stringify(requeued.job)}`);
  assert.equal(requeued.job.retryOf, first.id);
  assert.equal(requeued.job.commit, first.commit);
  assert.equal(requeued.job.requeuedFor, 'worker-gone');
  assert.equal(requeued.item.item_status, 'claimed', 'clause 1: the builder keeps the claim');
  assert.equal(handoffEvents(box, box.id, 'infrastructure'), 1, 'clause 1: one board event records the ended job');
  await drain();
  assert.equal(handoffEvents(box, box.id, 'infrastructure'), 1, 'clause 1: a second drain adds no event for the same item');

  const shown = box.run(box.web, 'show', String(box.id));
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /requeued on the same source after worker-gone/u, 'clause 2: show names the requeue and its reason');
  const json = JSON.parse(box.run(box.web, 'show', String(box.id), '--json').out);
  assert.equal(json.queuedSubmit.requeuedFor, 'worker-gone', 'clause 2: show --json carries the reason');
});

test('clause 1: a drain ends a hand-off whose folder no longer exists as infrastructure once, and the builder keeps the claim [C7]', async t => {
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '../../../../../..');
  const tools = join(box.dir, 'silent-tools');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const worker = join(tools, 'apps/cli/src/io/gate/drive.js');
  // Only the launched gate driver process exits, before it drives anything.
  writeFileSync(worker, `if (process.argv[1]?.endsWith('gate-drive-worker.js')) process.exit(0);\n` + readFileSync(worker, 'utf8'));
  const subOut = execFileSync(process.execPath, [join(tools, 'apps/cli/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(JSON.parse(subOut).queued, true);
  const first = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', first.id);
  await box.helpers.waitFor(() => driverRecord(box, first.id)?.pid > 0, 'the dispatcher recording its driver', 120000); // budget: hang ceiling for observed dispatcher progress.
  const owner = driverRecord(box, first.id);
  assert.equal(existsSync(join(directory, 'worker.json')), false, 'the driver is recorded on the board, never beside the hand-off');
  await box.helpers.waitFor(() => { // budget: owned process exit ceiling, not a timing assertion.
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, 'actual first worker exit', 120000);
  rmSync(directory, { recursive: true, force: true });
  forgetDriver(box, first.id);
  const drain = () => drainOnce(box, source);

  ageHandoff(box, box.id, 11 * 60_000);
  const swept = await drainOnce(box, source, () => !['queued', 'running'].includes(state(box, box.id).job.state));
  const ended = state(box, box.id);
  assert.notEqual(ended.job.state, 'queued', `clause 1: a ghost queued job is not left in the gate\n${swept}\n${JSON.stringify(ended.job)}`);
  assert.notEqual(ended.job.state, 'running');
  assert.equal(ended.item.item_status, 'claimed', 'clause 1: the builder keeps the claim');
  const ends = () => handoffEvents(box, box.id, ended.job.state);
  assert.equal(ends(), 1, 'clause 1: one board event records the ended job');
  await drain();
  assert.equal(ends(), 1, 'clause 1: a second drain adds no event');
});
