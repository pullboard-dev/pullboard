/** The status line says when the server's state worker stopped and the view serves from the request thread; an adapter test that runs the generated page code. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applyStateDelta } from '../../../../packages/api/index.js';
import { cockpitLive } from '../../index.js';
import { expandItemSummaries } from '../../index.js';
import { pageScriptPart3 } from '../../index.js';

/** The generated board listing reader and status line, run together as the page runs them, with an explicit listing reply. */
function pageStatus(listing, stream) {
  const reader = pageScriptPart3({ applyStateDelta, deriveMilestoneForecasts: function deriveMilestoneForecasts(state) { return state; }, expandItemSummaries });
  const live = cockpitLive({ pageScriptPart1: () => '', pageScope: {}, pageScriptPart2: () => '', pageScriptPart3: () => '' });
  const from = reader.indexOf('function projectGroups(');
  const to = reader.indexOf('/** Whether a board state already carries', from);
  const line = live.indexOf('function liveLine()');
  assert.ok(from >= 0 && to > from && line >= 0, 'the generated page contains its board reader and its status line');
  const context = { snapshot: false, localBoardIds: new Set(), data: { projects: [] }, stream, api: async () => listing };
  const page = runInNewContext(reader.slice(from, to) + live.slice(line, live.indexOf('/** Stop following', line)) + '; ({ boardState, liveLine })', context);
  return { read: () => page.boardState('/root', null), line: () => page.liveLine() };
}

test('view.x-cockpit-worker-line.the-status-line-says-the-state-worker: the status line says the state worker stopped and the view serves from the request thread [N26,C7]', async () => {
  const page = pageStatus({ boards: [], stateWorker: 'stopped' }, { status: 'up' });
  await page.read();
  assert.equal(page.line(), 'the state worker stopped: serving from the request thread');
});

test('view.x-cockpit-worker-line.the-status-line-says-nothing-about-the: the status line says nothing about the state worker while it is not stopped [N26,C7]', async () => {
  for (const stateWorker of [undefined, 'running']) {
    const page = pageStatus({ boards: [], stateWorker }, { status: 'up' });
    await page.read();
    assert.equal(page.line(), '', 'a worker that is not stopped adds no words to the status line');
  }
});
