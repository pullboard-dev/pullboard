/** pullboard land --item N lands one accepted item through the landing package while a trunk hold is set, and status counts it [C7,#3775]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { makeMergeBoard } from '../../tests/fixtures/land/merge-board.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
const { boardFixture, accepted } = makeMergeBoard(e2e);

test('clause 1: with landing.byHand on, land --item N lands one accepted item while a trunk hold is set, prints the reason and the bypassed hold, and status counts it as landed [C7,#3775]', async t => {
  t.after(e2e.cleanup);
  const box = boardFixture();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { landing: { byHand: true } });
  // A committed test whose recorded defect holds the trunk: its repair item is open and no run clears it.
  writeFileSync(join(box.repo, 'test/held.test.js'), "import { test } from 'node:test';\ntest('held case', () => {});\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add the held test');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: 'test/held.test.js', hash: 'a'.repeat(64),
    blob: box.git(box.repo, 'rev-parse', 'main:test/held.test.js'), trunkBlob: null, names: ['held case'], lane: 'web', batchId: randomUUID(), branch: 'refs/heads/main' }));
  const id = accepted(box, 1, { 'docs/landed-by-hand.md': '# Landed by hand\n' });
  const before = box.git(box.repo, 'rev-parse', 'main');
  const run = await box.runLocal(box.repo, 'land', '--item', String(id), '--reason', 'the held test is unrelated to this item');
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /the held test is unrelated to this item/u, 'the reason is printed');
  assert.match(run.out, /bypassed hold: .*test\/held\.test\.js/u, 'the bypassed hold is named');
  const after = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(after, before, 'main moved to the merge commit');
  assert.equal(box.git(box.repo, 'show', 'main:docs/landed-by-hand.md'), '# Landed by hand');
  const status = await box.runLocal(box.repo, 'status', '--json');
  assert.equal(status.code, 0, status.out + status.err);
  assert.equal(JSON.parse(status.out).stats.stages.landed, 1, 'status counts the item as landed');
});
