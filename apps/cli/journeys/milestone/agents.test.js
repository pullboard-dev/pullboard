/** An agent or the coordinator adding to a milestone at its limit is told to ask the person; older boards replay unchanged [N26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { editMilestone } from '../../../../packages/store/index.js';
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
  const ids = [1, 2].map((n) => cellItem(board, { lane: 'web', title: `item ${n}`, criterion: 'Tracked work', specIds: ['G1'] }).item_id);
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', note: null, items: [String(ids[0])], reason: SETUP });
  editMilestone(board, 'release', { agentId: 'coordinator', limit: '1' });
  return { board, ids, items: () => store.milestones(board)[0].items };
}

test('[N26,H16] adding to a milestone at its limit is refused with the next step (ask the person)', (t) => {
  const box = fixture(t);
  assert.throws(() => store.editMilestoneItems(box.board, 'release', { agentId: 'coordinator', add: [box.ids[1]], remove: [], reason: SETUP }), (error) => {
    assert.equal(error.code, 'MILESTONE_LIMIT');
    assert.match(error.message, /ask the person/u);
    return true;
  });
  assert.deepEqual(box.items(), [box.ids[0]], 'a refused add changes nothing');
  store.editMilestoneItems(box.board, 'release', { agentId: 'coordinator', add: [box.ids[1]], remove: [], swap: [box.ids[0]], reason: SETUP });
  assert.deepEqual(box.items(), [box.ids[1]], 'a swap stays open');
});

test('[N26,H16] a board recorded at the previous engine keeps the old add refusal', (t) => {
  const box = fixture(t);
  const current = box.board.executionEngineVersion;
  try {
    box.board.executionEngineVersion = MILESTONE_PERSON_LIMIT_ENGINE - 1;
    assert.throws(() => store.editMilestoneItems(box.board, 'release', { agentId: 'coordinator', add: [box.ids[1]], remove: [], reason: SETUP }), (error) => {
      assert.equal(error.code, 'MILESTONE_LIMIT');
      assert.doesNotMatch(error.message, /ask the person/u);
      return true;
    });
  } finally { box.board.executionEngineVersion = current; }
});
