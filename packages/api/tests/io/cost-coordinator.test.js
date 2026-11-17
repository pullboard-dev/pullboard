/** The cost analytics answer carries the coordinator's recorded usage as its own entry, and unknown rather than zero when none is recorded [C7,#9834]. @pullboard-test-input source-cell packages/api packages/stats packages/store */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCostAnalytics } from '../../src/io/cost.js';
import { costAnalyticsSliced } from '../../../stats/index.js';
import { coordinatorUsage } from '../../../stats/index.js';
import { publicUsage } from '../../../stats/index.js';
import { costWindowStart } from '../../../stats/index.js';
import { recordCoordinatorUsage } from '../../../store/index.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';

/** The model name the recorded coordinator session reports. */
const SESSION_MODEL = ['fixture', 'coordinator'].join('-');

/** One real board, read the way the API reads it: a work function handed the open board. */
function answer(t, record) {
  const project = cellProject(t), board = openCellBoard(project.boardFile);
  t.after(() => closeCellBoard(board));
  if (record) recordCoordinatorUsage(board, { session: 'coordinator-session-1', observedAt: 5, records: [{ model: SESSION_MODEL, inputTokens: 10, outputTokens: 4,
    knownInputTokens: 10, knownOutputTokens: 4, wallMs: 0, freshInputTokens: 3, cacheReadInputTokens: 5, cacheWriteInputTokens: 2, unknownReasons: [] }] });
  const io = { read: work => work(board), now: new Date('2026-11-16T12:00:00Z'), modelPresentation: model => ({ key: model, name: model, vendor: null }), answers: new Map(), costWindowStart, costAnalyticsSliced,
    coordinatorUsage: current => publicUsage(coordinatorUsage(current)) };
  return readCostAnalytics({ root: project.repo }, '7d', io);
}

test('api.cost-coordinator.costanalytics-output-carries-coordinator-entry: clause 1: costAnalytics output carries the coordinator entry with its tokens and models when a session is recorded [C7,#9834]', async t => {
  const { coordinator } = await answer(t, true);
  assert.equal(coordinator.sessions, 1);
  assert.equal(coordinator.inputTokens, 10);
  assert.equal(coordinator.outputTokens, 4);
  assert.deepEqual(coordinator.models, [SESSION_MODEL]);
});

test('api.cost-coordinator.costanalytics-output-carries-coordinator-entry-2: clause 1: costAnalytics output carries a coordinator entry that reads unknown, not zero, when none is recorded [C7,#9834]', async t => {
  const { coordinator } = await answer(t, false);
  assert.equal(coordinator.sessions, 0);
  assert.equal(coordinator.inputTokens, null);
  assert.equal(coordinator.outputTokens, null);
});
