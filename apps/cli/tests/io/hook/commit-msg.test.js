/** The commit-msg refusal's seat hint names an item folder only when the board created it, and says how to create it otherwise [C7,#12023]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { itemFolderPath } from '../../../../../packages/items/light.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runCommitMsgInProcess } from '../../fixtures/hook/commit-msg.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose web seat holds one claimed item, and the item's id and folder path. */
async function claimedProject() {
  const box = e2e.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Hint item', '--criterion', 'the hint is true', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err);
  return { box, id, folder: itemFolderPath(box.web, id) };
}

/** The refusal the seat checkout prints for a message the hook cannot accept. */
async function refusal(box) {
  const answer = await runCommitMsgInProcess(box, box.web, 'add the page [G1]');
  assert.equal(answer.status, 1, answer.stderr);
  return answer.stderr;
}

test('cli.io-hook-commit-msg.hint-names-existing-folder-only: clause 1: seatItemFolderHints for a claimed item whose folder does not exist returns no line containing that path [C7,#12023]', async () => {
  const { box, folder } = await claimedProject();
  box.git(box.repo, 'worktree', 'remove', '--force', folder);
  const text = await refusal(box);
  assert.ok(!text.includes(folder), `the refusal names no missing folder: ${text}`);
});

test('cli.io-hook-commit-msg.hint-for-missing-folder: clause 2: an item with no folder gets the line naming pullboard claim with its id, and an item whose folder exists still gets the cd line with its real path [C7,#12023]', async () => {
  const { box, id, folder } = await claimedProject();
  const present = await refusal(box);
  assert.ok(present.includes(`cd ${folder} && pullboard submit ${id}`), `the cd line names the real folder: ${present}`);
  box.git(box.repo, 'worktree', 'remove', '--force', folder);
  const missing = await refusal(box);
  assert.ok(missing.includes(`#${id} has no item folder yet; run pullboard claim ${id}`), `the claim line names the id: ${missing}`);
});
