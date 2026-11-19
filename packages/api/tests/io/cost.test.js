/** @pullboard-test-input source-cell packages/api */
/** The cost analytics answer carries this machine's budget state beside its totals, and leaves the entry out when no budget is set (#11057, #1059) [C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { boardId } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { readCostAnalytics } from '../../src/io/cost.js';
import { createLocalApiHandler } from '../../index.js';

const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] });
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`a cost call does not project ${name}`); }])));
/** The state a stand-in budget reader reports. */
const WARN = { state: 'warn', spend: 7, limit: 8, which: 'dailyUsd' };

/** One real board read the way the API reads it, with the cost slicer replaced by an empty answer so only the budget entry is under test. */
function answer(t, budgetState) {
  const project = cellProject(t), board = openCellBoard(project.boardFile);
  t.after(() => closeCellBoard(board));
  const io = { read: work => work(board), now: new Date('2026-11-16T12:00:00Z'), modelPresentation: model => ({ key: model, name: model, vendor: null }), answers: new Map(),
    costWindowStart: () => new Date('2026-11-09T12:00:00Z'), costAnalyticsSliced: async () => ({ totals: {} }), ...(budgetState ? { budgetState } : {}) };
  return readCostAnalytics({ root: project.repo }, '7d', io);
}

test('api.cost.the-cost-analytics-answer-carries-the-budget-state: clause 1: the cost analytics answer carries the budget state its port reads, and no budget entry when none is set [C7,#11057]', async t => {
  assert.deepEqual((await answer(t, () => WARN)).budget, WARN);
  assert.equal('budget' in await answer(t, () => null), false, 'a port that reads no budget leaves the entry out');
  assert.equal('budget' in await answer(t), false, 'no port, no entry');
});

test('api.cost.the-cost-analytics-answer-carries-the-budget-route: clause 2: the cost analytics answer carries the machine budget state through the route when budget.dailyUsd is set [C7,#11057]', async t => {
  const project = cellProject(t, { real: true });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { budget: { dailyUsd: 8 } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const board = openCellBoard(project.boardFile);
  let id;
  try { id = boardId(board); } finally { closeCellBoard(board); }
  const secret = 'fixture-secret';
  let port = 0;
  const handler = createLocalApiHandler({ secret, getPort: () => port, runCommand: async () => 0, isMain: false, boardOpeners: OPENERS, viewPorts: VIEW_PORTS,
    projects: () => [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-14' }],
    refusalDocument: (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
    costModelPresentation: model => ({ key: model, name: model, vendor: null }) });
  const server = createServer(handler);
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); }); });
  t.after(async () => { handler.close(); const closed = new Promise(done => server.close(done)); server.closeAllConnections(); await closed; });
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/boards/${id}/cost-analytics?window=7d`, { headers: { 'x-pullboard-key': secret }, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, await response.clone().text());
  const { costAnalytics } = await response.json();
  assert.deepEqual(costAnalytics.budget, { state: 'ok', spend: 0, limit: 8, which: 'dailyUsd' });
});
