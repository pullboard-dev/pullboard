/** The store milestones module releases through a provided coordinatorMilestoneRelease when one is set, and through its import otherwise [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { addMilestone } from '../../../../../store/index.js';
import { provideCoordinatorMilestoneRelease } from '../../../../../store/index.js';
import { shipMilestone } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';

/** A real repo and board with two milestones, A to ship and B to take what is left; no provider stays set after the test. */
function fixture(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  t.after(() => provideCoordinatorMilestoneRelease(null));
  for (const name of ['A', 'B']) addMilestone(board, { agentId: 'coordinator', name, note: null, items: [] });
  const ship = () => shipMilestone(board, 'A', { agentId: 'coordinator', coordinatorActions: true, commit: project.git(project.repo, 'rev-parse', 'main') });
  const shipped = () => JSON.parse(board.db.prepare("SELECT event_detail FROM event WHERE event_kind='milestone_ship' ORDER BY event_id DESC LIMIT 1").get().event_detail);
  return { board, ship, shipped };
}

test('board.milestones-provider.with-provider-set-the-module-still: clause 2: with no provider set the module still answers through its current import, so shipping records the stats gauge [C7,H16]', t => {
  const box = fixture(t);
  box.ship();
  const recorded = box.shipped().coordinatorActions;
  assert.ok(recorded.gauge, 'the imported release computed a gauge');
  assert.equal(recorded.previous, null);
});

test('board.milestones-provider.provided-release-the-one-shipmilestone-calls: clause 1: a provided release is the one shipMilestone calls and its answer is what the ship event records [C7,H16]', t => {
  const box = fixture(t);
  const calls = [];
  provideCoordinatorMilestoneRelease((board, options) => { calls.push(options); return { gauge: { provided: true }, previous: null, problem: null }; });
  box.ship();
  assert.equal(calls.length, 1, 'the provided function ran once');
  assert.deepEqual(calls[0].plannedMoves, ['milestone_ship'], 'it received the release options');
  assert.deepEqual(box.shipped().coordinatorActions.gauge, { provided: true }, 'its answer is what the ship event records');
});
