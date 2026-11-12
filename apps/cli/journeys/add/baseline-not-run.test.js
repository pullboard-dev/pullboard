/** With no live runner a pending check baseline reads "not run yet" with its next line, never "running in the background" [C7,#6559]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Add one item to a scratch project that has no runner, and show it. */
async function addAndShow(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Baseline waits', '--specs', 'G1', '--criterion', 'It works [test]', '--check', 'node --test web/none.test.js');
  assert.equal(added.code, 0, added.err + added.out);
  const id = added.out.match(/^#(\d+)/mu)[1];
  return { added, shown: await box.runLocal(box.repo, 'show', id) };
}

test('clause 1: add with no live runner prints "check baseline: not run yet" and the next line "pullboard runner local" [C7,#6559]', async t => {
  const { added } = await addAndShow(t);
  assert.ok(added.out.includes('check baseline: not run yet\nnext: pullboard runner local'), added.out + added.err);
  assert.doesNotMatch(added.out, /running in the background/);
});

test('clause 2: show prints the same line until a baseline lands, never "running in the background" [C7,#6559]', async t => {
  const { shown } = await addAndShow(t);
  assert.ok(shown.out.includes('check baseline: not run yet'), shown.out + shown.err);
  assert.doesNotMatch(shown.out, /running in the background/);
});
