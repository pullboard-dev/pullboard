/** Claimed companions are real source inputs, never permission for a builder's off-lane edits [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { prepareItemPatchReview } from '../../../../../packages/items/index.js';
import { effectiveItemHead } from '../../../../../packages/verify/index.js';
import { itemPolicy } from '../../../../../packages/sandbox/index.js';
import { requireTrunkMerge } from '../../../../../packages/sandbox/index.js';
import { retryReviewCommit } from '../../../../../packages/verify/index.js';
import { itemPatchAuthors } from '../../../../../packages/items/index.js';
import { prepareItemPatchSubmit } from '../../../../../packages/items/index.js';
import { sealItemPatchSubmit } from '../../../../../packages/items/index.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { document } from '../../../tests/fixtures/companion/presubmit.js';
import { run } from '../../../tests/fixtures/companion/presubmit.js';
import { actorGit } from '../../../tests/fixtures/companion/presubmit.js';
import { fixture } from '../../../tests/fixtures/companion/presubmit.js';
import { attach } from '../../../tests/fixtures/companion/presubmit.js';
import { repeatNativePhases } from '../../../tests/fixtures/companion/presubmit.js';

test('claimed companion submits the real core command and records exact composed native proof [C7,V4,H16]', async t => {
  const f = await fixture(t);
  await attach(f);
  const claimed = store.getItem(f.board, f.id);
  assert.equal(claimed.item_status, 'claimed');
  assert.equal(claimed.item_owner, f.builder.id);
  const beforeHead = f.box.git(f.builder.root, 'rev-parse', 'HEAD');
  const beforeIndex = f.box.git(f.builder.root, 'write-tree');
  const submitted = await settleSubmit(t, f.box, document(await run(f.box, f.builder, 'submit', String(f.id))));
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
  assert.equal(store.getItem(f.board, f.id).item_commit, f.source);
  const event = store.events(f.board).filter(row => row.event_kind === 'submit' && row.item_id === f.id).at(-1);
  const detail = JSON.parse(event.event_detail);
  const binding = detail.companion;
  assert.equal(binding.source, f.source);
  assert.notEqual(binding.commit, f.source);
  assert.equal(binding.sourceTree, f.box.git(f.builder.root, 'rev-parse', `${f.source}^{tree}`));
  assert.equal(binding.tree, f.box.git(f.builder.root, 'rev-parse', `${binding.commit}^{tree}`));
  assert.equal(prepareItemPatchReview(f.builder.root, f.board, store.getItem(f.board, f.id),
    { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem: store.getItem }).commit, binding.commit,
    'submit and verifier share the actual deterministic composition');
  assert.deepEqual(binding.phases.map(phase => phase.role), ['criterion', 'proof']);
  // The pulled gate hands the board its plan beside the event; replay it as the board host does [P7].
  const options = { ...detail, agentId: f.builder.id, pulledPlan: { phases: binding.phases, proofFiles: detail.submissionProof.files, full: detail.submissionProof.full } };
  assert.equal(sealItemPatchSubmit(f.board, f.id, options), options);
  for (const index of [0, 1]) {
    const incomplete = { ...binding, receiptIds: [binding.receiptIds[index]], phases: [binding.phases[index]] };
    assert.throws(() => sealItemPatchSubmit(f.board, f.id, { ...options, companion: incomplete }), { code: 'ITEM_PATCH_CHANGED' });
  }
  const repeated = await repeatNativePhases(f, binding);
  const substitute = { ...binding, receiptIds: [binding.receiptIds[0], repeated[0]] };
  assert.notEqual(substitute.receiptIds[0], substitute.receiptIds[1]);
  for (const id of substitute.receiptIds) assert.equal(store.proofReceipts(f.board, f.id).find(row => row.id === id).submitPhase, 'criterion');
  assert.throws(() => sealItemPatchSubmit(f.board, f.id, { ...options, companion: substitute }), { code: 'ITEM_PATCH_CHANGED' });
  for (const id of binding.receiptIds) {
    const receipt = store.proofReceipts(f.board, f.id).find(row => row.id === id);
    assert.equal(receipt.commit, binding.commit);
    assert.equal(receipt.tree, binding.tree);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.sourceClean, true);
  }
  // The pulled gate receipt does not echo the companion (PULL_GAP #7184: gate receipt fields); the board's own submit binding and the proof receipts above carry the composed commit.
  assert.equal(submitted.gateJob.step, 'done');
  assert.equal(f.box.git(f.builder.root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(f.box.git(f.builder.root, 'write-tree'), beforeIndex);
  assert.equal(existsSync(join(f.builder.root, 'view/header.cjs')), false);
  assert.equal(f.box.git(f.builder.root, 'status', '--porcelain'), '');
  assert.equal(f.box.git(f.builder.root, 'worktree', 'list', '--porcelain').includes('pullboard-companion-submit-'), false);
});

test('an ordinary builder commit follows its unchanged companion without coordinator rebinding [C7,V4]', async t => {
  const f = await fixture(t);
  await attach(f);
  writeFileSync(join(f.builder.root, 'core/second.cjs'), 'module.exports = 2;\n');
  f.box.git(f.builder.root, 'add', 'core/second.cjs');
  actorGit(f.box, f.builder, 'commit', '-m', 'feat(core): advance real builder head [G1]');
  const moved = f.box.git(f.builder.root, 'rev-parse', 'HEAD');
  await settleSubmit(t, f.box, document(await run(f.box, f.builder, 'submit', String(f.id))));
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
  assert.ok(store.proofReceipts(f.board, f.id).length > 0, 'the followed composition actually executes');
  assert.equal(store.itemPatches(f.board, f.id)[0].key, 'approved-view');
  assert.equal(store.events(f.board).filter(event => event.item_id === f.id && event.event_kind === 'item_patch_follow').length, 1);
  assert.equal(prepareItemPatchSubmit(f.builder.root, f.board, store.getItem(f.board, f.id), moved).source, moved);
  assert.equal(itemPatchAuthors(f.board, f.id).length, 1, 'following never removes original author custody');
});

test('a nonapplying claimed companion refuses by key without mutating builder source [C7,V4]', async t => {
  const f = await fixture(t);
  const bad = join(f.box.dir, 'conflicting.patch');
  writeFileSync(bad, 'diff --git a/view/missing.cjs b/view/missing.cjs\n--- a/view/missing.cjs\n+++ b/view/missing.cjs\n@@ -1 +1 @@\n-missing old content\n+new content\n');
  await attach(f, 'cannot-apply-view', f.source, bad);
  const rejected = await run(f.box, f.builder, 'submit', String(f.id));
  assert.equal(rejected.code, 1);
  assert.match(rejected.out + rejected.err, /cannot-apply-view/u);
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
  assert.equal(f.box.git(f.builder.root, 'rev-parse', 'HEAD'), f.source);
  assert.equal(f.box.git(f.builder.root, 'status', '--porcelain'), '');
});

test('claimed patch lanes and original builder lane edits remain independently enforced [C7,V4,B2]', async t => {
  const f = await fixture(t);
  const wrong = await run(f.box, f.coordinator, 'patch', 'attach', String(f.id), f.patchFile,
    '--key', 'wrong-author', '--author', f.builder.id, '--source', f.source);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out + wrong.err, /OUTSIDE_LANE/u);
  await attach(f);
  mkdirSync(join(f.builder.root, 'view'));
  writeFileSync(join(f.builder.root, 'view/illegal.cjs'), 'module.exports = 9;\n');
  f.box.git(f.builder.root, 'add', 'view/illegal.cjs');
  const previous = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = f.builder.session;
  let hook;
  try { hook = f.box.tryGit(f.builder.root, 'commit', '-m', 'feat(core): forbidden lane edit [G1]'); }
  finally { if (previous === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = previous; }
  assert.notEqual(hook.status, 0);
  assert.match(hook.stderr, /outside|lane|view/iu);
  const submitted = await run(f.box, f.builder, 'submit', String(f.id));
  assert.equal(submitted.code, 1);
  assert.match(submitted.out + submitted.err, /DIRTY|OUTSIDE_LANE/u);
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
});
