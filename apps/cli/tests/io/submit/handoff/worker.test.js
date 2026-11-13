/** A locked board never kills a gate driver, and a queued job keeps its place in line [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
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
import { queuedElsewhere } from '../../../../../../packages/resources/index.js';
import { recordHandoffQueue } from '../../../../../../packages/resources/index.js';
import { replaceLostTicketOnce } from '../../../../../../packages/resources/index.js';
import { recordTicketSafely } from '../../../../src/io/submit/handoff/worker.js';

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
