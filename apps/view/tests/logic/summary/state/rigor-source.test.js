/** The View spec rows show an auto-drafted Rigor row's readable source line, never raw encoded JSON [D1,S1]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { automaticRigorSource } from '../../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellProject } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { projectState } from '../../../../src/io/serve.js';

test('view.x-summary-state-rigor-source.the-spec-row-card-text-carries-the: the spec row card text carries the readable Rigor source line and no rigor-auto:%7B text [D1,S1]', t => {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile);
  const cause = { key: 'test:x.test.js::fails', items: [{ id: 12, commits: ['a'.repeat(40)] }], occurrences: 2, neverAgain: false };
  appendFileSync(join(project.repo, 'SPEC.md'), `- G9 [draft, must] Review how to prevent repeats. Source: ${automaticRigorSource(cause, [5])} | gate: web test\n`);
  const row = projectState(project.repo, { board }).spec.find(entry => entry.id === 'G9');
  assert.ok(row, 'the drafted row reaches the view state');
  assert.equal(row.text.includes('rigor-auto:%7B'), false);
  assert.match(row.text, /Source: Rigor evidence for test:x\.test\.js::fails, 2 occurrences across #12\./u);
});
