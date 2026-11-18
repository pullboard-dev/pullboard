/** handoffGateCurrent keeps a running gate going for its serving item and for the item its own submit just moved, and for nothing else [C7,#4073]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { completeSubmitHandoff } from '../../../../../../../store/index.js';
import { getItem } from '../../../../../../../store/index.js';
import { handoffGateCurrent } from '../../../../../../../store/index.js';
import { handoffServes } from '../../../../../../../store/index.js';
import { release } from '../../../../../../../store/index.js';
import { startSubmitHandoff } from '../../../../../../../store/index.js';
import { submitHandoff } from '../../../../../../../store/index.js';
import { writeBoardCommand } from '../../../../../../../store/index.js';
import { submitFixture } from '../../../../../../../store/tests/fixtures/submit.js';
import { cellBoard } from '../../../../../fixtures/cell-board.js';
import { cellClaim } from '../../../../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../../../store/tests/fixtures/cell.js';

/**
 * A board with one item claimed by its seat, one candidate committed, and that candidate's gate queued then running.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ project: object, web: string, board: object, seat: object, id: number, job: string, commit: string, tree: string }}
 */
function runningGate(t) {
  const project = cellProject(t, { real: true, gate: 'true', config: { submit: { handoff: true } } });
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: web });
  const seat = cellSeat(board, { lane: 'web', path: web });
  const id = cellItem(board, { lane: 'web', title: 'Gate current source', specIds: ['G1'], route: 'strong',
    criterion: 'The candidate passes.', check: 'true' }).item_id;
  cellClaim(board, id, seat, { root: web, itemFolder: true });
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web/current.txt'), 'x\n');
  project.git(web, 'add', '-A');
  assert.equal(project.tryGit(web, 'commit', '-q', '-m', 'feat(web): current candidate [G1]').status, 0);
  const commit = project.git(web, 'rev-parse', 'HEAD');
  const tree = project.git(web, 'rev-parse', 'HEAD^{tree}');
  const item = getItem(board, id);
  const job = randomUUID();
  writeBoardCommand(board, 'queueSubmitHandoff', [id, { agentId: seat.id, job, main: project.git(web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest, companionDigest: null,
    leaseMs: 7_200_000 }], seat.id);
  assert.equal(startSubmitHandoff(board, id, { agentId: seat.id, job }).started, true);
  return { project, web, board, seat, id, job, commit, tree };
}

test('board.current.claimed-item-whose-hand-off-running: clause 1: a claimed item whose hand-off is running serves, so its gate is current [C7]', t => {
  const { board, id, job } = runningGate(t);
  assert.equal(handoffServes(board, id, job), true);
  assert.equal(handoffGateCurrent(board, id, job), true);
});

test('board.current.the-item-its-own-gate-just: clause 1: the item its own gate just submitted at the hand-off head, by the hand-off seat and at its digest, is still current [C7,#4073]', t => {
  const { board, seat, id, job, commit, tree } = runningGate(t);
  submitFixture(board, id, { agentId: seat.id, commit, tree });
  const item = getItem(board, id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(submitHandoff(board, id).state, 'running', 'the hand-off still reads running until its result is stored');
  assert.equal(handoffServes(board, id, job), false, 'a submitted item no longer serves, so only the finishing gate stays current');
  assert.equal(handoffGateCurrent(board, id, job), true);
});

test('board.current.item-submitted-another-head-than-the: clause 1: an item submitted at another head than the hand-off\'s is not current [C7,#4073]', t => {
  const { board, seat, id, job, commit } = runningGate(t);
  const other = commit.startsWith('a') ? 'b'.repeat(40) : 'a'.repeat(40);
  submitFixture(board, id, { agentId: seat.id, commit: other, tree: other });
  const item = getItem(board, id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_built_by, seat.id, 'the same seat submitted');
  assert.equal(item.item_frozen_digest, submitHandoff(board, id).digest, 'at the same digest');
  assert.notEqual(item.item_commit, submitHandoff(board, id).commit, 'only the head differs');
  assert.equal(handoffGateCurrent(board, id, job), false);
});

test('board.current.item-submitted-the-hand-off-head: clause 1: an item submitted at the hand-off head by another seat is not current [C7,#4073]', t => {
  const { project, board, seat, id, job, commit, tree } = runningGate(t);
  const other = join(project.dir, 'web-two');
  project.git(project.repo, 'worktree', 'add', '-q', other, '-b', 'web/two');
  const second = cellSeat(board, { lane: 'web', path: other });
  release(board, id, seat.id, 'Hand the fixture claim to another seat.', 'OTHER');
  cellClaim(board, id, second, { root: other, itemFolder: true });
  submitFixture(board, id, { agentId: second.id, commit, tree });
  const item = getItem(board, id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_commit, submitHandoff(board, id).commit, 'at the same head');
  assert.equal(item.item_frozen_digest, submitHandoff(board, id).digest, 'at the same digest');
  assert.equal(submitHandoff(board, id).state, 'running', 'the first seat\'s hand-off is still running');
  assert.notEqual(item.item_built_by, submitHandoff(board, id).agentId, 'only the seat differs');
  assert.equal(handoffGateCurrent(board, id, job), false);
});

test('board.current.another-hand-off-finished-hand-off: clause 1: another hand-off id, a finished hand-off and an item with no hand-off are not current [C7]', t => {
  const { board, seat, id, job } = runningGate(t);
  assert.equal(handoffGateCurrent(board, id, randomUUID()), false, 'a gate for another job id is stale');
  completeSubmitHandoff(board, id, { agentId: seat.id, job,
    result: { code: 1, error: { code: 'FIXTURE_FINISHED', message: 'The gate finished.', next: 'No worker was launched.' } } });
  assert.equal(submitHandoff(board, id).state, 'red');
  assert.equal(handoffGateCurrent(board, id, job), false, 'a done hand-off is not current');
  const bare = cellItem(board, { lane: 'web', title: 'No hand-off', specIds: ['G1'], route: 'strong', criterion: 'Passes.', check: 'true' }).item_id;
  assert.equal(handoffGateCurrent(board, bare, job), false, 'an item with no hand-off is not current');
});
