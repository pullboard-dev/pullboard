/** A dead gate worker is swept the moment it exits, the sweep reaches it fast, and a locked board never kills a driver [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureBoard } from '../../../fixtures/board.js';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { createJob } from '../../../../../../packages/jobs/index.js';
import { takeJob } from '../../../../../../packages/jobs/index.js';
import { jobView } from '../../../../../../packages/jobs/index.js';
import { recordJobRow } from '../../../../../../packages/drive/index.js';
import { drainHandoffQueue } from '../../../../../../packages/resources/index.js';
import { exitedWithoutResult } from '../../../../../../packages/resources/index.js';
import { HANDOFF_SWEEP_EVERY_MS } from '../../../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../../../packages/resources/index.js';
import { capturedLaunchUnseen } from '../../../../src/io/submit/handoff.js';
import { sweepOrder } from '../../../../src/io/submit/handoff.js';
import { queuedElsewhere } from '../../../../../../packages/resources/index.js';
import { recordHandoffQueue } from '../../../../../../packages/resources/index.js';
import { replaceLostTicketOnce } from '../../../../../../packages/resources/index.js';
import { recordTicketSafely } from '../../../../src/io/submit/handoff/worker.js';
import { waitForCondition } from '../../../fixtures/runner/holders.js';

/** A worker that dies at once with no result, as a crashed gate driver does. */
const DYING_WORKER = 'process.exit(1);\n';

/** A private machine home and a captured tools tree whose gate driver dies at once. */
function fixture() {
  const dir = realpathSync(temporaryDirectory('pullboard-dead-restart-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), DYING_WORKER);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  /** Put the environment back and remove the private tree. */
  const cleanup = () => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, cleanup };
}

test('a worker that exits with no result is swept within seconds, not at the next timed sweep [C7]', async t => {
  const box = fixture();
  try {
    const directory = join(box.dir, 'jobs', 'job1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: 'job1' }) + '\n');
    queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job: 'job1' }, await reserveHandoffTicket('job1'));
    const sweptAt = [];
    const started = Date.now();
    // The timed sweep is far away, so only the exit can start the second sweep.
    const drained = drainHandoffQueue({ capacity: 1, pollMs: 20, sweep: async () => { sweptAt.push(Date.now() - started); }, sweepEveryMs: 10 * 60_000 });
    await waitForCondition(() => sweptAt.length >= 2, 'the dead worker swept on its exit', { signal: t.signal });
    assert.ok(sweptAt[1] < 10_000, `the exit sweep ran ${sweptAt[1]} ms after the drain started; a dead gate restarts in seconds`);
    assert.deepEqual((await drained).started, ['job1']);
  } finally { box.cleanup(); }
});

test('the timed sweep runs every 15 s at most, and an exit with a written result asks for no extra sweep [C7]', () => {
  assert.ok(HANDOFF_SWEEP_EVERY_MS <= 15_000, 'a worker an earlier dispatcher started is swept within 15 s of its death');
  const dir = temporaryDirectory('pullboard-dead-result-');
  try {
    const startedAt = Date.now() - 1000;
    writeFileSync(join(dir, 'submission.json'), '{}\n');
    utimesSync(join(dir, 'submission.json'), new Date(), new Date());
    const finished = new Map([[1, { exited: true, directory: dir, startedAt, resultAt: null }]]);
    assert.equal(exitedWithoutResult(finished), false, 'a worker that wrote its result is not a death');
    const dead = new Map([[1, { exited: true, directory: join(dir, 'none'), startedAt, resultAt: null }]]);
    assert.equal(exitedWithoutResult(dead), true, 'a worker that exited with no result is a death');
    assert.equal(exitedWithoutResult(dead), false, 'each death asks for one sweep');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sweep takes the queue-order lock only for a queued job with no captured request and no place in line, and reaches running jobs first [C7]', async () => {
  const box = fixture();
  try {
    const captured = join(box.dir, 'jobs', 'captured');
    mkdirSync(captured, { recursive: true });
    writeFileSync(join(captured, 'request.json'), '{}\n');
    assert.equal(capturedLaunchUnseen(captured, 'captured'), false, 'a captured request proves the launch began');
    const lined = join(box.dir, 'jobs', 'lined');
    mkdirSync(lined, { recursive: true });
    await reserveHandoffTicket('lined');
    assert.equal(capturedLaunchUnseen(lined, 'lined'), false, 'a place in line proves the launch began');
    assert.equal(capturedLaunchUnseen(join(box.dir, 'jobs', 'lost'), 'lost'), true, 'only a job with neither needs the locked check');
    const order = sweepOrder([{ itemId: 1, job: { state: 'queued' } }, { itemId: 9, job: { state: 'running' } }, { itemId: 3, job: { state: 'running' } }]);
    assert.deepEqual(order.map(row => row.itemId), [3, 9, 1]);
  } finally { box.cleanup(); }
});

test('a lease renewal that meets a locked board answers not held and the driver lives; any other row still throws [C7]', t => {
  // File storage is needed to hold the real SQLite writer lock from a second connection.
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA busy_timeout = 0');
  createJob(writer, { id: 'gate-drive:j1', kind: 'gate-drive' });
  assert.equal(takeJob(writer, 'gate-drive:j1', 'driver-1').taken, true);
  const holder = new DatabaseSync(file);
  holder.exec('BEGIN EXCLUSIVE');
  const notes = [];
  try {
    const renew = { type: 'ticket', action: 'renew', job: 'gate-drive:j1', owner: 'driver-1', at: Date.now() };
    assert.throws(() => recordJobRow(writer, renew), /database is locked/u, 'the raw renewal throws on a locked board');
    assert.equal(recordTicketSafely(renew, () => recordJobRow(writer, renew), line => notes.push(line)), false);
    assert.match(notes[0], /gate lease renew for gate-drive:j1 met a locked board/u);
    const step = { type: 'step', job: 'gate-drive:j1', name: 'running', seq: 0, payload: {}, at: Date.now() };
    assert.throws(() => recordTicketSafely(step, () => recordJobRow(writer, step), () => {}), /database is locked/u, 'a step row is never dropped');
  } finally { holder.exec('ROLLBACK'); holder.close(); }
  const renew = { type: 'ticket', action: 'renew', job: 'gate-drive:j1', owner: 'driver-1', at: Date.now() };
  assert.equal(recordTicketSafely(renew, () => recordJobRow(writer, renew)), true, 'the next tick renews once the board is free');
  assert.equal(jobView(writer, 'gate-drive:j1').leaseOwner, 'driver-1');
  writer.close();
});

test('a queued job keeps its place: a sweep reading another machine queue never calls it lost, and a lost place is re-placed once [C7]', () => {
  const box = fixture();
  try {
    const directory = join(box.dir, 'jobs', 'queued');
    mkdirSync(directory, { recursive: true });
    recordHandoffQueue(directory);
    assert.equal(queuedElsewhere(directory), false, 'the queue that holds the place may judge it');
    const home = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'other-home');
    try { assert.equal(queuedElsewhere(directory), true, 'a dispatcher with another machine home cannot see this ticket, so it leaves the job alone'); }
    finally { process.env.PULLBOARD_MACHINE_HOME = home; }
    assert.equal(queuedElsewhere(join(box.dir, 'jobs', 'unrecorded')), false, 'a job from before the record is judged as before');
    assert.equal(replaceLostTicketOnce(directory), true, 'the first loss re-places the ticket');
    assert.equal(replaceLostTicketOnce(directory), false, 'a second loss is an infrastructure stop');
  } finally { box.cleanup(); }
});
