/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/generated/docs.js apps/cli/tests/fixtures/move/registry/baseline.json docs/api.md docs/tools/update-docs.js */
/** Public land retains mechanical additions and returns a real conflict, apart from merge.test.js so each fits its file limit under pull [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { makeMergeBoard } from '../../../tests/fixtures/land/merge-board.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';
import { whenRunnerSettles } from '../../../tests/fixtures/runner/local-start.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { boardFixture, accepted } = makeMergeBoard(e2e);

// CONTROLLER_ONLY: the add-only JSON and Markdown retention is the batch engine's mechanical merge (packages/merge train.js); the pulled land job merges with plain git and returns an overlapping file as a conflict [C7].
test('public land retains JSON and Markdown additions [B3,R3,C7]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

test('public land returns a same-line edit that really conflicts to its builder [B3,R3,C7]', async () => {
  const box = boardFixture();
  const competing = accepted(box, 3, { 'docs/api.md': '# Edited by first item\n\nEnd.\n' });
  const conflict = accepted(box, 4, { 'docs/api.md': '# Edited by second item\n\nEnd.\n' });
  const returned = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(returned.landed, [competing], 'both accepts are fresh against the batch base; their actual composition exposes the conflict');
  assert.deepEqual(returned.returned.map(entry => [entry.id, entry.reason]), [[conflict, 'conflict']]);
  const item = json(box, box.repo, 'show', String(conflict));
  assert.equal(item.item_status, 'open', 'a real conflicting accepted submission returns to its builder');
  await whenRunnerSettles(box.env, () => box.git(box.remote, 'rev-parse', 'main') === returned.batch.tip, { deadlineMs: 30_000, what: 'origin to take the landed tip' });
});
