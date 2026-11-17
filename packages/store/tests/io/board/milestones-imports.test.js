/** @pullboard-test-input source-cell store board stats */
/** The store milestones module imports nothing from the stats package, and the coordinator release still reads the same values through the board root [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addMilestone } from '../../../index.js';
import { board_ensureCoordinator } from '../../../index.js';
import { shipMilestone } from '../../../index.js';
import { openBoard } from '../../../../board/index.js';
import { coordinatorMilestoneRelease } from '../../../../stats/light.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';

const SOURCE = fileURLToPath(new URL('../../../src/io/board/milestones.js', import.meta.url));

/** A gauge without its clock-stamped window, which differs between two calls. */
const undated = ({ since, until, ...rest }) => rest;

test('clause 1: milestones.js has no import, export-from or dynamic import of the stats package, light door included [C7]', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const specifiers = [...source.matchAll(/(?:from\s*|import\(\s*|require\(\s*)['"]([^'"]+)['"]/gu)].map(match => match[1]);
  assert.ok(specifiers.length > 0, 'the module has imports to check');
  assert.deepEqual(specifiers.filter(specifier => /(^|\/)stats(\/|$)/u.test(specifier)), [], 'no specifier names the stats package');
});

test('clause 2: a ship through the board root records the same release values the stats function answers [C7]', t => {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  assert.equal(typeof openBoard, 'function', 'the board root is loaded, so it has provided the release');
  board_ensureCoordinator(board, project.repo);
  for (const name of ['A', 'B']) addMilestone(board, { agentId: 'coordinator', name, note: null, items: [] });
  const direct = coordinatorMilestoneRelease(board, { plannedMoves: ['milestone_ship'] });
  shipMilestone(board, 'A', { agentId: 'coordinator', coordinatorActions: true, commit: project.git(project.repo, 'rev-parse', 'main') });
  const recorded = JSON.parse(board.db.prepare("SELECT event_detail FROM event WHERE event_kind='milestone_ship' ORDER BY event_id DESC LIMIT 1").get().event_detail).coordinatorActions;
  assert.deepEqual(undated(recorded.gauge), undated(direct.gauge));
  assert.equal(recorded.previous, direct.previous);
});
