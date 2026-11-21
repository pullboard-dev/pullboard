/** @pullboard-test-input source-cell apps/cli */
/** submittedWithoutGate drives the board submit move over a hand-written pass receipt and leaves the claimed item submitted at its committed head, with no runner gate job [C7,#9873]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { onBoard } from './land/board.js';
import { fileFixtureItem } from './testkit.js';
import { fixtureSettledMachine } from './testkit.js';
import { createE2eHelpers } from './e2e.js';
import {
  gateJobCount,
  seamSubmittedItem,
  submittedWithoutGate,
} from './submitted-seam.js';
import { clean } from './verdict-check.js';
import { project } from './verdict-check.js';
import { sandbox } from './verdict-check.js';
import { succeeds } from './verdict-check.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A claimed item with one committed change in its seat. */
async function claimedItem(box) {
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Seam submit', run: box.runLocal });
  const claim = await box.runLocal(box.web, 'claim', String(item.item_id));
  assert.equal(claim.code, 0, claim.out + claim.err);
  const commit = e2e.commitFile(box, box.web, 'web/seam.js', 'export const seam = 1;\n', 'feat(web): seam change [G1]');
  assert.equal(commit.status, 0, commit.stderr);
  return item.item_id;
}

test('cli.tests-fixtures-submitted-seam.submitted-at-the-committed-head: clause 1: submittedWithoutGate(box, cwd, id) drives the board submit move with that receipt and leaves the claimed item submitted at its committed head, readable by pullboard show [C7,#9873]', async () => {
  const box = e2e.project();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: false } });
  const id = await claimedItem(box);
  const receiptId = submittedWithoutGate(box, box.web, id);
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  const item = onBoard(box, board => store.getItem(board, id));
  assert.equal(item.item_status, 'submitted', 'the board holds the item submitted');
  assert.ok(onBoard(box, board => store.proofReceipts(board, id)).some(row => row.id === receiptId), 'the receipt it submitted over is on the item');
  const shown = await box.runLocal(box.web, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.match(shown.out, new RegExp(head), 'pullboard show names the committed head');
});

test('cli.tests-fixtures-submitted-seam.no-runner-gate-job: clause 2: the same submit leaves no runner gate job for the item [C7,#9873]', async () => {
  const box = e2e.project();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: false } });
  const id = await claimedItem(box);
  submittedWithoutGate(box, box.web, id);
  assert.equal(gateJobCount(box, id), 0, 'no runner gate job exists');
});

test('cli.tests-fixtures-submitted-seam.verify-accept-after-the-seam: clause 1: verify accept on the seam-submitted item succeeds and the item reads verified [C7,#9874]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const id = await seamSubmittedItem(box, repo, web);
    const accepted = await succeeds(box, repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    assert.match(accepted, /accept|verified|criterion/iu, 'the accept on the seam-submitted item succeeds');
    assert.match(await succeeds(box, repo, 'show', String(id)), /verified/u, 'the item reads verified');
  } finally { clean(box); }
});
