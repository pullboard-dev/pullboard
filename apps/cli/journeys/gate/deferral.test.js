/** @pullboard-test-input packages/sandbox/src/io/trusted/policy.js */
/** Deferred landing of a large affected selection at submit (C7); the inline, split and policy cases sit in deferral/. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import * as store from '../../../../packages/store/index.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { makeDeferralFixtures } from '../../tests/fixtures/gate/deferral.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { largeSelectionProject } = makeDeferralFixtures(e2e, store);

test('a pulled gate over submitDeferAbove records the deferral from its plan, not hard-coded values [C7]', async t => {
  const selected = Array.from({ length: 30 }, (_, index) => `web/selected-${String(index).padStart(2, '0')}.test.js`);
  const on = largeSelectionProject(t, 20);
  const green = await on.submitChange(2);
  assert.equal(green.receipt.gate.full, false);
  assert.equal(green.receipt.gate.deferred, true);
  assert.deepEqual(green.ran, ['guard'], 'submit ran the frozen check, static checks and the invariant file only');
  assert.deepEqual(green.proof.submissionProof.files, ['web/guard.test.js'], 'the receipt names what actually ran');
  assert.equal(green.proof.submissionProof.deferred, true);
  assert.deepEqual(green.proof.submissionProof.deferredFiles, selected, 'the submission records the thirty deferred files');
  assert.match(green.proof.note, /30 affected test files deferred to the landing gate/u, 'reviewers see the deferral');
  assert.match(green.receipt.gate.report, /30 affected test files deferred to the landing gate/u);
});

test('a large affected selection is deferred to landing at submit, and a red deferred selection lands nothing [C7]', async t => {
  const selected = Array.from({ length: 30 }, (_, index) => `web/selected-${String(index).padStart(2, '0')}.test.js`);
  const all = [...Array.from({ length: 30 }, (_, index) => String(index)), 'guard'].sort();
  const on = largeSelectionProject(t, 20);
  const green = await on.submitChange(2);
  assert.equal(green.receipt.gate.full, false);
  assert.equal(green.receipt.gate.deferred, true);
  assert.deepEqual(green.ran, ['guard'], 'submit ran the frozen check, static checks and the invariant file only');
  assert.deepEqual(green.proof.submissionProof.files, ['web/guard.test.js'], 'the receipt names what actually ran');
  assert.deepEqual(green.proof.submissionProof.deferredFiles, selected, 'the submission records the thirty deferred files');
  assert.match(green.proof.note, /30 affected test files deferred to the landing gate/u, 'reviewers see the deferral');
  assert.match(green.receipt.gate.report, /30 affected test files deferred to the landing gate/u);
  on.accept(green.id, green.receipt.commit);
  rmSync(on.box.env.DEFER_MARKER, { force: true });
  const landed = on.box.run(on.box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  assert.deepEqual((await settleLand(on.box, JSON.parse(landed.out))).landed, [green.id]);
  assert.deepEqual(on.ran().sort(), all, 'landing ran every deferred file before the item landed');

  const red = await on.submitChange('red');
  assert.deepEqual(red.ran, ['guard'], 'a red deferred file is not run at submit');
  on.accept(red.id, red.receipt.commit);
  const blocked = on.box.run(on.box.repo, 'land', '--json');
  assert.equal(blocked.code, 0, `a pulled landing offers its job and returns: ${blocked.err}${blocked.out}`);
  assert.deepEqual((await settleLand(on.box, JSON.parse(blocked.out))).landed, [], 'a red deferred selection lands nothing');
  const reopened = JSON.parse(on.box.run(on.box.repo, 'show', String(red.id), '--json').out);
  assert.notEqual(reopened.item_status, 'verified', 'the red item is sent back like a red submit');
  assert.equal(reopened.item_merged_commit, null);
  assert.ok(reopened.thread.some(entry => entry.kind === 'reopen' && /web\/selected-00\.test\.js/u.test(entry.detail.note)), 'the reopen names the failing deferred file');
});
