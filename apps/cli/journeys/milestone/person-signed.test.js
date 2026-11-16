/** The person's signed move raises a milestone limit and adds past it; an agent or the coordinator still cannot [N26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { editMilestone } from '../../../../packages/store/index.js';
import { editMilestoneItems } from '../../../../packages/store/index.js';
import { MILESTONE_PERSON_LIMIT_ENGINE } from '../../../../packages/state/index.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';

const SETUP = 'fixture release setup';

/** A real Git project and board with a milestone at its limit of 1, plus two spare items. */
function fixture(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  const ids = [1, 2, 3].map(n => cellItem(board, { lane: 'web', title: `item ${n}`, criterion: 'Tracked work', specIds: ['G1'] }).item_id);
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', note: null, items: [String(ids[0])], reason: SETUP });
  editMilestone(board, 'release', { agentId: 'coordinator', limit: '1' });
  return { board, ids, items: () => store.milestones(board)[0].items, limit: () => store.milestones(board)[0].limit };
}

test('clause 1: a signed person move raising a milestone limit is accepted while the coordinator is refused [N26,H16]', t => {
  const box = fixture(t);
  assert.ok(box.board.executionEngineVersion >= MILESTONE_PERSON_LIMIT_ENGINE, 'the fixture board runs the person-limit rule');
  assert.throws(() => editMilestone(box.board, 'release', { agentId: 'coordinator', limit: '5' }), { code: 'MILESTONE_LIMIT_PERSON' });
  assert.equal(box.limit(), 1, 'a refused raise changes nothing');
  editMilestone(box.board, 'release', { agentId: 'coordinator', limit: '5', asPerson: true });
  assert.equal(box.limit(), 5);
});

test('clause 2: a signed person move adding an item to a milestone at its limit is accepted while the coordinator is refused [N26,H16]', t => {
  const box = fixture(t);
  assert.throws(() => editMilestoneItems(box.board, 'release', { agentId: 'coordinator', add: [box.ids[1]], remove: [], reason: SETUP }), { code: 'MILESTONE_LIMIT' });
  assert.deepEqual(box.items(), [box.ids[0]], 'a refused add changes nothing');
  editMilestoneItems(box.board, 'release', { agentId: 'coordinator', add: [box.ids[1]], remove: [], reason: SETUP, asPerson: true });
  assert.deepEqual(box.items(), [box.ids[0], box.ids[1]]);
  assert.equal(box.limit(), 1, 'the person add leaves the limit as it was');
});

test('clause 2: a board recorded at the previous engine keeps the old refusal even for a person add [N26,H16]', t => {
  const box = fixture(t);
  const current = box.board.executionEngineVersion;
  try {
    box.board.executionEngineVersion = MILESTONE_PERSON_LIMIT_ENGINE - 1;
    assert.throws(() => editMilestoneItems(box.board, 'release', { agentId: 'coordinator', add: [box.ids[2]], remove: [], reason: SETUP, asPerson: true }), { code: 'MILESTONE_LIMIT' });
  } finally { box.board.executionEngineVersion = current; }
});
