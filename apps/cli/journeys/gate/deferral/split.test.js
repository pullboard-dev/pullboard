/** @pullboard-test-input packages/sandbox/src/io/trusted/policy.js */
/** Deferred landing of a large affected selection, bisect and setting-off cases (C7). */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../tests/fixtures/e2e.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
import * as store from '../../../../../packages/store/index.js';
import { makeDeferralFixtures } from '../../../tests/fixtures/gate/deferral.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { largeSelectionProject } = makeDeferralFixtures(e2e, store);

test('a deferred selection is bisected so B does not land without A\'s fix [C7]', () => {
  // Item A carries the fix B's deferred files need, and also turns the gate red; bisect removes A and rebuilds B alone.
  const split = largeSelectionProject(20, { inline: true });
  const second = join(split.box.dir, 'web-2');
  split.box.git(split.box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  // The second seat joins on the strong route like web-1, so it may claim the strong-routed items both build.
  const secondJoin = joinFixtureSeat(split.box, second, 'web', { model: FIXTURE_MODEL });
  assert.equal(secondJoin.code, 0, `join: ${secondJoin.err}${secondJoin.out}`);
  const itemA = split.submitChange('a', { files: [['web/fix.js', 'export const fixed = true;\n'], ['web/RED', 'red\n']] });
  const itemB = split.submitChange('needs-fix', { cwd: second });
  split.accept(itemA.id, itemA.receipt.commit);
  split.accept(itemB.id, itemB.receipt.commit);
  const splitLanding = split.box.run(split.box.repo, 'land', '--json');
  assert.equal(splitLanding.code, 1, `every candidate is a culprit, so land exits 1 [#4265]: ${splitLanding.err}${splitLanding.out}`);
  assert.deepEqual(JSON.parse(splitLanding.out).landed, [], 'B does not land on a rebuilt tree that lost A\'s fix');
  for (const id of [itemA.id, itemB.id]) {
    const shown = JSON.parse(split.box.run(split.box.repo, 'show', String(id), '--json').out);
    assert.notEqual(shown.item_status, 'verified', `#${id} is sent back`);
    assert.equal(shown.item_merged_commit, null);
  }
  const reopenedB = JSON.parse(split.box.run(split.box.repo, 'show', String(itemB.id), '--json').out);
  assert.ok(reopenedB.thread.some(entry => entry.kind === 'reopen' && /web\/selected-\d\d\.test\.js/u.test(entry.detail.note)), 'B is sent back for its own deferred files');
});

test('with the deferral setting off, submit runs every affected file as today [C7]', () => {
  const all = [...Array.from({ length: 30 }, (_, index) => String(index)), 'guard'].sort();
  const off = largeSelectionProject(null).submitChange(2);
  assert.equal(off.proof.submissionProof.deferredFiles, undefined);
  assert.deepEqual(off.ran.sort(), all, 'with the setting off, submit runs all thirty as today');
});
