/** @pullboard-test-input source-cell store */
// fixture-subject: writeBoardCommand for release and verify over a real board, a real Git checkout and a real machine-home queue folder
/** With board.crossProcessWrites on, a release and a verdict go through the machine's file write queue and answer from its result file [C7,#9817,#8163]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { board_ensureCoordinator } from '../../../index.js';
import { events } from '../../../index.js';
import { getItem } from '../../../index.js';
import { merged } from '../../../index.js';
import { writeBoardCommand } from '../../../index.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellClaim } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

const COMMIT = 'a'.repeat(40);
const BRIEF = 'Fix the thing.\n\nFiles:\n- web/result.txt\n\nTest: web/result.test.js asserts the result.';

/** A board with a private machine home holding the given settings, a claimed item for the release and a landed item for the verdict. */
function setup(t, settings) {
  const project = cellProject(t, { real: true });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  board_ensureCoordinator(board, project.repo);
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const reviewer = cellSeat(board, { lane: 'web', path: `${project.dir}/reviewer` });
  const claimed = cellItem(board, { lane: 'web', title: 'Release fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  cellClaim(board, claimed, seat, { root: project.dir });
  const landed = cellItem(board, { lane: 'web', title: 'Verdict fixture', criterion: '1. It works [test]', specIds: ['G1'], route: 'mid', brief: BRIEF, check: 'node --test web/result.test.js' }).item_id;
  merged(board, landed, { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'test fixture' });
  const count = (id, kind) => events(board, { itemId: id }).filter(e => e.event_kind === kind).length;
  const release = () => writeBoardCommand(board, 'release', [claimed, seat.id, 'giving it back'], seat.id);
  const verdict = () => writeBoardCommand(board, 'verify', [landed, { agentId: reviewer.id, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the result is wrong',
    head: COMMIT, digest: '', policy: 'any', landed: true, keepCheck: true }], reviewer.id);
  return { board, claimed, landed, home, count, release, verdict };
}

/** The result files the queue folder holds. */
const results = home => readdirSync(join(home, 'board-write-queue')).filter(name => name.endsWith('.result'));

test('clause 1: with board.crossProcessWrites on, release and verify each go through the file queue and return their stored result [C7,#9817]', async t => {
  const f = setup(t, { board: { crossProcessWrites: true } });
  const released = await f.release();
  assert.equal(results(f.home).length, 1, 'the release left one result file');
  assert.equal(getItem(f.board, f.claimed).item_status, 'open');
  assert.equal(f.count(f.claimed, 'release'), 1);
  assert.equal(typeof released, 'boolean', 'the caller got the release\'s stored answer');
  const answer = await f.verdict();
  assert.equal(results(f.home).length, 2, 'the verdict left a second result file');
  assert.equal(getItem(f.board, f.landed).item_verdict, 'REJECT');
  assert.equal(f.count(f.landed, 'verify'), 1);
  assert.equal(typeof answer, 'object');
  assert.notEqual(answer, null);
});

test('clause 2: a release or verdict retried with the same write id is answered from its result file with no second event [C7,#9817]', async t => {
  const f = setup(t, { board: { crossProcessWrites: true } });
  const released = await f.release();
  assert.deepEqual(await f.release(), released);
  assert.equal(f.count(f.claimed, 'release'), 1, 'the retried release wrote no second event');
  const first = await f.verdict();
  assert.deepEqual(await f.verdict(), first);
  assert.equal(f.count(f.landed, 'verify'), 1, 'the retried verdict wrote no second event');
});

test('clause 3: with board.crossProcessWrites off release and verify write directly and return at once, with no queue folder [C7,#9817]', t => {
  const f = setup(t, {});
  const released = f.release();
  assert.equal(typeof released?.then, 'undefined', 'the direct release is synchronous');
  assert.equal(getItem(f.board, f.claimed).item_status, 'open');
  const answer = f.verdict();
  assert.equal(typeof answer?.then, 'undefined', 'the direct verdict is synchronous');
  assert.equal(getItem(f.board, f.landed).item_verdict, 'REJECT');
  assert.equal(existsSync(join(f.home, 'board-write-queue')), false);
});
