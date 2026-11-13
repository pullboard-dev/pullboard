/** A hotfix already on main is submitted for post-hoc review, measured against its own parent, never EMPTY_SUBMIT [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('a one-file hotfix already on main submits for review and is not refused EMPTY_SUBMIT [C7,V4]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'hotfix review', '--specs', 'G1', '--criterion', 'The feature is present.',
    '--check', 'test -f web/feature.txt', '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  const committed = helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', `fix(web): add the feature [G1]\n\nPullboard-Item: #${id}`);
  assert.equal(committed.status, 0, committed.stderr);
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  const result = await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json');
  const refusal = result.code === 0 ? null : JSON.parse(result.out).error;
  assert.notEqual(refusal?.code, 'EMPTY_SUBMIT', result.out);
});
