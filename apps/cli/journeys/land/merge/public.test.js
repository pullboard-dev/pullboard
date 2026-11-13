/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/generated/docs.js apps/cli/tests/fixtures/move/registry/baseline.json docs/api.md docs/tools/update-docs.js */
/** Public land retains mechanical additions and returns a real conflict, apart from merge.test.js so each fits its file limit under pull [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { makeMergeBoard } from '../../../tests/fixtures/land/merge-board.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { boardFixture, accepted } = makeMergeBoard(e2e);

test('public land retains JSON and Markdown additions, while a same-line edit really reopens [B3,R3,C7]', async () => {
  const box = boardFixture();
  const left = accepted(box, 1, { 'test/snapshot.json': '{"base":true,"left":true}\n', 'docs/api.md': '# API\n\nLeft.\nEnd.\n' });
  const right = accepted(box, 2, { 'test/snapshot.json': '{"base":true,"right":true}\n', 'docs/api.md': '# API\n\nRight.\nEnd.\n' });
  const landed = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(landed.landed, [left, right]);
  assert.deepEqual(landed.returned, []);
  assert.deepEqual(JSON.parse(box.git(box.repo, 'show', 'main:test/snapshot.json')), { base: true, left: true, right: true });
  assert.match(box.git(box.repo, 'show', 'main:docs/api.md'), /Left\.\nRight\./u);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.git(box.repo, 'rev-parse', 'main'));
  const competing = accepted(box, 3, { 'docs/api.md': '# Edited by first item\n\nLeft.\nRight.\nEnd.\n' });
  const conflict = accepted(box, 4, { 'docs/api.md': '# Edited by second item\n\nLeft.\nRight.\nEnd.\n' });
  const returned = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(returned.landed, [competing], 'both accepts are fresh against the batch base; their actual composition exposes the conflict');
  assert.deepEqual(returned.returned.map(entry => [entry.id, entry.reason]), [[conflict, 'conflict']]);
  const item = json(box, box.repo, 'show', String(conflict));
  assert.equal(item.item_status, 'open', 'a real conflicting accepted submission returns to its builder');
});
