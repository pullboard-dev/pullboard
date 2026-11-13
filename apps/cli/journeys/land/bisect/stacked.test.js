/** Land refuses an item stacked on an unverified ancestor, apart from bisect.test.js so each fits its file limit under pull [B3,R3,E8]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';
import { drainOwnedProcesses } from '../../../tests/fixtures/land/drain.js';
import { json } from '../../../tests/fixtures/land/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('land never takes an item whose stack holds an unverified ancestor [B3,R3,E8]', async () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = [itemWorktree(box, 1, FILES[0]), itemWorktree(box, 4, FILES[3])];
  submitItem(box, entries[0], 'PASS\n');
  const hidden = itemWorktree(box, 5, 'web/unverified.js');
  assert.equal(commitFile(box, hidden.path, hidden.file, '// unverified\n', 'feat(web): unverified ancestor [G1]').status, 0);
  const hiddenSha = box.git(hidden.path, 'rev-parse', 'HEAD');
  box.git(entries[1].path, 'merge', '--no-ff', hiddenSha, '-m', 'feat(web): include ancestor [G1]');
  submitItem(box, entries[1]);
  for (const entry of entries) acceptItem(box, entry);
  assert.equal((await box.runLocal(hidden.path, 'submit', String(hidden.item), '--no-next')).code, 0);
  delete box.env.LAND_SUPPRESS_RED;
  await drainOwnedProcesses(box.dir);
  const result = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(result.landed, [entries[0].item], JSON.stringify(result.landJob?.receipt ?? result));
  assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_merged_commit, null, 'the unverified stack never gets in');
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  await drainOwnedProcesses(box.dir);
});
