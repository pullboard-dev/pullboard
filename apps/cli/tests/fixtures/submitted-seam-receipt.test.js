/** @pullboard-test-input source-cell apps/cli packages/store */
/** The submitted-seam fixture writes a pass receipt a pulled gate would record, and the board reads it as a pass with no runner gate job [C7,#9872]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { onBoard } from './land/board.js';
import { fileFixtureItem } from './testkit.js';
import { createE2eHelpers } from './e2e.js';
import {
  gateJobCount,
  passReceipt,
} from './submitted-seam.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A claimed item with one committed change in its seat. */
async function claimedItem(box) {
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Seam receipt', run: box.runLocal });
  const claim = await box.runLocal(box.web, 'claim', String(item.item_id));
  assert.equal(claim.code, 0, claim.out + claim.err);
  const commit = e2e.commitFile(box, box.web, 'web/seam.js', 'export const seam = 1;\n', 'feat(web): seam change [G1]');
  assert.equal(commit.status, 0, commit.stderr);
  return item.item_id;
}

/** The receipts the board holds for one item, read through the store. */
function receiptsOf(box, id) {
  return onBoard(box, board => store.proofReceipts(board, id));
}

test('clause 1: passReceipt(box, id) writes a pass receipt for the claimed item\'s committed head in the shape a pulled gate records [C7,#9872]', async () => {
  const box = e2e.project();
  const id = await claimedItem(box);
  const receiptId = passReceipt(box, id, box.web);
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  const receipt = receiptsOf(box, id).find(row => row.id === receiptId);
  assert.ok(receipt, 'the receipt is on the item');
  assert.equal(receipt.kind, 'submit');
  assert.equal(receipt.commit, head, 'it covers the committed head');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.counts.failed, 0);
  assert.equal(receipt.sourceClean, true);
});

test('clause 2: the store reads that receipt as a pass for the item and creates no runner gate job [C7,#9872]', async () => {
  const box = e2e.project();
  const id = await claimedItem(box);
  const receiptId = passReceipt(box, id, box.web);
  const receipt = receiptsOf(box, id).find(row => row.id === receiptId);
  assert.equal(receipt.item, id, 'the receipt is bound to the item');
  assert.equal(receipt.exitCode === 0 && receipt.counts.failed === 0 && receipt.sourceClean, true, 'it reads as a pass');
  assert.equal(gateJobCount(box, id), 0, 'no runner gate job was created');
});
