/** Only the person raises a milestone limit; boards recorded earlier replay their raises unchanged [N26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { editMilestone } from '../../../../packages/store/index.js';
import { MILESTONE_PERSON_LIMIT_ENGINE } from '../../../../packages/state/light.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';

/** A real Git project and board with one milestone limited to 2. */
function fixture(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', note: null, items: [] });
  editMilestone(board, 'release', { agentId: 'coordinator', limit: '2' });
  return { board, limit: () => store.milestones(board)[0].limit };
}

test('[N26,H16] an agent or the coordinator is refused when raising a milestone limit, with the next step', (t) => {
  const box = fixture(t);
  for (const limit of ['3', 'none']) {
    assert.throws(() => editMilestone(box.board, 'release', { agentId: 'coordinator', limit }), (error) => {
      assert.equal(error.code, 'MILESTONE_LIMIT_PERSON');
      assert.match(error.message, /ask the person/u);
      return true;
    }, limit);
    assert.equal(box.limit(), 2, 'a refused raise changes nothing');
  }
  editMilestone(box.board, 'release', { agentId: 'coordinator', limit: '1' });
  assert.equal(box.limit(), 1, 'lowering stays open to the coordinator');
  editMilestone(box.board, 'release', { agentId: 'coordinator', limit: '1' });
  assert.equal(box.limit(), 1, 'an unchanged limit is not a raise');
  editMilestone(box.board, 'release', { agentId: 'coordinator', limit: '4', asPerson: true });
  assert.equal(box.limit(), 4, 'the person raises it');
});

test('[N26,H16] a board recorded at the previous engine replays an upward limit edit unchanged', (t) => {
  const box = fixture(t);
  const current = box.board.executionEngineVersion;
  try {
    box.board.executionEngineVersion = MILESTONE_PERSON_LIMIT_ENGINE - 1;
    editMilestone(box.board, 'release', { agentId: 'coordinator', limit: '5' });
    assert.equal(box.limit(), 5);
    editMilestone(box.board, 'release', { agentId: 'coordinator', limit: 'none' });
    assert.equal(box.limit(), null);
  } finally { box.board.executionEngineVersion = current; }
});
