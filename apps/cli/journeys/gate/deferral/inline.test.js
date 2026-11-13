/** @pullboard-test-input packages/sandbox/src/io/trusted/policy.js */
/** Deferred landing of a large affected selection, inline landing cases (C7). */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import * as store from '../../../../../packages/store/index.js';
import { makeDeferralFixtures } from '../../../tests/fixtures/gate/deferral.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { largeSelectionProject, deferredLandingLogs } = makeDeferralFixtures(e2e, store);

test('an inline landing whose gate passes anything still runs the deferred files and lands nothing on red [C7]', () => {
  const inline = largeSelectionProject(20, { inline: true });
  const inlineRed = inline.submitChange('red');
  assert.deepEqual(inlineRed.ran, ['guard']);
  inline.accept(inlineRed.id, inlineRed.receipt.commit);
  const inlineLanding = inline.box.run(inline.box.repo, 'land', '--json');
  assert.equal(inlineLanding.code, 1, `every candidate is a culprit, so land exits 1 [#4265]: ${inlineLanding.err}${inlineLanding.out}`);
  assert.deepEqual(JSON.parse(inlineLanding.out).landed, [], 'an inline landing whose gate passes anything still runs the deferred files and lands nothing on red');
  const inlineItem = JSON.parse(inline.box.run(inline.box.repo, 'show', String(inlineRed.id), '--json').out);
  assert.notEqual(inlineItem.item_status, 'verified', 'the inline red item is sent back');
  assert.equal(inlineItem.item_merged_commit, null);
  assert.ok(inline.ran().length > 1, 'the inline landing ran the deferred files');
});

test('a red deferred landing keeps its real failing file and durable log [C7]', () => {
const project = largeSelectionProject(20, { inline: true });
const red = project.submitChange('red');
project.accept(red.id, red.receipt.commit);
const result = project.box.run(project.box.repo, 'land', '--json');
assert.equal(result.code, 1, `every candidate is a culprit, so land exits 1 [#4265]: ${result.err}${result.out}`);
const shown = JSON.parse(project.box.run(project.box.repo, 'show', String(red.id), '--json').out);
assert.ok(shown.thread.some(entry => entry.kind === 'reopen' && /web\/selected-00\.test\.js/u.test(entry.detail.note)), 'the refusal retains the actual failing file');
const logs = deferredLandingLogs(project.box);
assert.ok(logs.some(log => /selected 0 \[G1\]/u.test(log.text) && /not ok/u.test(log.text)), 'a durable native landing log retains the actual failing test output');
});
