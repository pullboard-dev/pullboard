/** @pullboard-test-input source-cell store */
// fixture-subject: writeBoardCommand for claim over a real board, a real Git checkout and a real machine-home queue folder
/** With board.crossProcessWrites on, a claim goes through the machine's file write queue and answers from its result file [C7,#9816,#8163]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getItem } from '../../../index.js';
import { writeBoardCommand } from '../../../index.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

const FROZEN = { text: '{"criterion":"the fixture works"}', digest: createHash('sha256').update('{"criterion":"the fixture works"}').digest('hex') };

/** A board with one open item and a seat, and a private machine home holding the given settings. */
function setup(t, settings) {
  const project = cellProject(t, { real: true });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const target = cellItem(board, { lane: 'web', title: 'Queued claim fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  const options = { agentId: seat.id, lane: seat.lane, leaseMs: 3_600_000, itemFolder: true, freeze: () => FROZEN };
  const claims = () => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='claim' AND item_id=?").get(target).n;
  return { board, seat, target, options, home, claims };
}

test('clause 1: with board.crossProcessWrites on, a claim goes through the file queue under the machine home and returns the result file\'s answer [C7,#9816]', async t => {
  const { board, seat, target, options, home, claims } = setup(t, { board: { crossProcessWrites: true } });
  const answer = await writeBoardCommand(board, 'claim', [target, options], seat.id);
  const queue = join(home, 'board-write-queue');
  const results = readdirSync(queue).filter(name => name.endsWith('.result'));
  assert.equal(results.length, 1, 'the claim left one result file in the queue folder');
  assert.equal(getItem(board, target).item_status, 'claimed');
  assert.equal(getItem(board, target).item_owner, seat.id);
  assert.equal(claims(), 1);
  assert.equal(typeof answer, 'object', 'the caller got the claim\'s stored answer');
  assert.notEqual(answer, null);
});

test('clause 2: a claim retried with the same write id is answered from its result file with no second claim event [C7,#9816]', async t => {
  const { board, seat, target, options, claims } = setup(t, { board: { crossProcessWrites: true } });
  const first = await writeBoardCommand(board, 'claim', [target, options], seat.id);
  assert.equal(claims(), 1);
  // The caller died before reading its answer; its retry carries the same arguments, so the same write id.
  const again = await writeBoardCommand(board, 'claim', [target, { ...options }], seat.id);
  assert.deepEqual(again, first);
  assert.equal(claims(), 1, 'the retry wrote no second claim event');
});

test('clause 3: with board.crossProcessWrites off a claim writes directly and returns at once, with no queue folder [C7,#9816]', t => {
  const { board, seat, target, options, home, claims } = setup(t, {});
  const answer = writeBoardCommand(board, 'claim', [target, options], seat.id);
  assert.equal(typeof answer?.then, 'undefined', 'the direct write is synchronous');
  assert.equal(getItem(board, target).item_status, 'claimed');
  assert.equal(claims(), 1);
  assert.equal(existsSync(join(home, 'board-write-queue')), false);
});

test('clause 4: claim, release, then the same claim again with the file queue on gets a fresh result and a second claim event [C7,#10089]', async t => {
  const { board, seat, target, options, claims } = setup(t, { board: { crossProcessWrites: true } });
  await writeBoardCommand(board, 'claim', [target, options], seat.id);
  await writeBoardCommand(board, 'release', [target, seat.id, 'giving it back', undefined, 'OTHER'], seat.id);
  assert.equal(getItem(board, target).item_status, 'open');
  const again = await writeBoardCommand(board, 'claim', [target, { ...options }], seat.id);
  assert.equal(claims(), 2, 'the repeat claim wrote its own event instead of replaying the first answer');
  assert.equal(getItem(board, target).item_status, 'claimed');
  assert.equal(getItem(board, target).item_owner, seat.id);
  assert.notEqual(again, null);
});

test('clause 5: stored results and marks older than the keep time are pruned, newer ones and pending writes stay [C7,#10089]', async t => {
  const { board, seat, target, options, home } = setup(t, { board: { crossProcessWrites: true } });
  await writeBoardCommand(board, 'claim', [target, options], seat.id);
  const queue = join(home, 'board-write-queue');
  const old = join(queue, 'stale0000.result');
  const oldMark = join(queue, 'stale0000.mark');
  const pending = join(queue, 'stale0001.pending');
  for (const file of [old, oldMark, pending]) writeFileSync(file, '{}');
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  for (const file of [old, oldMark, pending]) utimesSync(file, past, past);
  // Any queued write prunes on the way in; the release is one.
  await writeBoardCommand(board, 'release', [target, seat.id, 'giving it back', undefined, 'OTHER'], seat.id);
  assert.equal(existsSync(old), false, 'the old result is gone');
  assert.equal(existsSync(oldMark), false, 'the old mark is gone');
  assert.equal(existsSync(pending), true, 'a pending write is never pruned');
  assert.ok(readdirSync(queue).some(name => name.endsWith('.result') && name !== 'stale0000.result'), 'this run\'s results are kept');
});
