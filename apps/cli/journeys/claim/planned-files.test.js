/** A brief path missing from main and owned by no lane is a planned file of the item's lane [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

/** File a web item as the coordinator (which may name any path) with the given brief, and try the web seat's claim. */
async function claimWithBrief(t, brief) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Planned file', criterion: 'The page renders.', brief, args: ['--specs', 'G1'] });
  return box.runLocal(box.web, 'claim', '1');
}

test('claiming an item whose brief names a file missing on main and owned by no lane succeeds [C7]', async t => {
  const claimed = await claimWithBrief(t, 'Files: web/page.html, test/new-thing.test.js.');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  assert.match(claimed.out, /claimed #1/u);
});

test('a brief path that exists on main outside the item lane still refuses CROSS_OWNERSHIP [C7]', async t => {
  const claimed = await claimWithBrief(t, 'Files: web/page.html, SPEC.md.');
  assert.notEqual(claimed.code, 0);
  assert.match(claimed.err + claimed.out, /CROSS_OWNERSHIP/u);
});
