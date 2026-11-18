/** The row-age worker starts even when the view runs under node --input-type=module -e [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { projectState } from '../../../src/io/serve.js';

test('view.x-io-live-row-ages-node-e.clause-1-a-view-started-through-node: clause 1: a view started through node --input-type=module -e still refreshes row ages in its worker [C7]', async t => {
  const project = cellProject(t, { real: true }), board = cellBoard(t, project.boardFile);
  // Under node -e the process carries the eval flags; a worker that inherited them would run the script, not the ages.
  const kept = process.execArgv;
  process.execArgv = ['--input-type=module', '-e', 'throw new Error("a worker inherited the eval script")'];
  t.after(() => { process.execArgv = kept; });
  const options = { board, rowAgesLater: true };
  const first = projectState(project.repo, options);
  assert.ok(Object.values(first.rowAgesAt).every(at => at === null), 'the first read walks nothing');
  let state = first;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && Object.values(state.rowAgesAt).every(at => at === null)) {
    await new Promise(done => setImmediate(done));
    state = projectState(project.repo, options);
  }
  assert.ok(Object.values(state.rowAgesAt).length > 0 && Object.values(state.rowAgesAt).every(at => typeof at === 'string'), 'the worker refreshed the ages for HEAD');
});
