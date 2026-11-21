/** The API's first state read answers at once and leaves the row-age history walks to a later refresh [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewApiPorts } from '../../../src/io/ports.js';
import { projectState } from '../../../src/io/serve.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';

test('view.x-io-live-api-state-later.clause-1-the-api-state-read-through: clause 1: the API state read through viewApiPorts keeps no row ages on a first read, where plain projectState walks history [C7]', t => {
  const project = cellProject(t), board = cellBoard(t, project.boardFile);
  const api = viewApiPorts.projectState(project.repo, { board });
  assert.ok(Object.values(api.rowAgesAt).every(at => at === null), 'the first API read has no kept ages, so it walked no spec or doctrine history');
  const walked = projectState(project.repo, { board });
  assert.ok(Object.values(walked.rowAgesAt).every(at => typeof at === 'string'), 'plain projectState walks history on the request path and names the commit');
});
