/** A milestone records whether it rolls over or takes items explicitly, over real Git and SQLite [N26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { editMilestone } from '../../../../store/index.js';
import { roadmap } from '../../../../store/index.js';
import { workQueue } from '../../../../items/index.js';
import { milestoneRoadmap } from '../../../../roadmap/index.js';
import { listApiProjects } from '../../../../seats/index.js';
import { cellBoard } from '../../fixtures/cell-board.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../fixtures/cell-board.js';

/** A real Git project and its board, with a milestone to edit and the roadmap document to read it back. */
function fixture(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', note: null, items: [] });
  const edit = change => editMilestone(board, 'release', { agentId: 'coordinator', ...change });
  const plan = () => milestoneRoadmap(project.repo, board, { ports: { ...store, roadmap, openBoard: openCellBoard, workQueue, listApiProjects } }).find(entry => entry.name === 'release');
  return { board, edit, plan };
}

test('clause 1: milestone edit --mode stores explicit and the roadmap shows it [N26,H16]', (t) => {
  const box = fixture(t);
  box.edit({ mode: 'explicit' });
  assert.equal(store.milestones(box.board)[0].mode, 'explicit');
  assert.equal(box.plan().mode, 'explicit');
  box.edit({ mode: 'rollover' });
  assert.equal(box.plan().mode, 'rollover');
  assert.throws(() => box.edit({ mode: 'sideways' }), { code: 'MILESTONE_MODE' });
  const currentEngine = box.board.executionEngineVersion;
  try {
    box.board.executionEngineVersion = 1;
    assert.throws(() => box.edit({ mode: 'explicit' }), { code: 'ENGINE_VERSION' });
  } finally { box.board.executionEngineVersion = currentEngine; }
});

test('clause 2: the mode defaults to rollover and an existing limit reads as rollover [N26,H16]', (t) => {
  const box = fixture(t);
  assert.equal(box.plan().mode, 'rollover');
  box.edit({ limit: '3' });
  assert.equal(store.milestones(box.board)[0].mode, undefined, 'an older limit stores no mode');
  assert.equal(box.plan().mode, 'rollover');
  assert.equal(box.plan().limit, 3);
});
