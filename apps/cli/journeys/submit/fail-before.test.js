/** Submit asks a [test] clause for a fail-before receipt only when verify.failBefore is on [C7,#8110]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
import { json } from '../../tests/fixtures/land/board.js';

/** Submit an item whose one [test] clause names a committed test, with no recorded run at its base; failBefore is as given. */
async function submitWithoutReceipt(t, failBefore) {
  // Budget: one private project, one claim, one clause tick and one submit; the ceiling is for hangs, not a speed target.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const verify = { ...config.verify, inspectClauses: true };
  if (failBefore === undefined) delete verify.failBefore; else verify.failBefore = failBefore;
  fixtureProjectPolicy(box.repo, { config: { ...config, verify } });
  const id = String(json(box, box.repo, 'add', 'web', 'Render page', '--specs', 'G1', '--criterion', '1. web/page.test.js passes [test]', '--check', 'true').item.item_id);
  json(box, box.web, 'claim', id);
  assert.equal(helpers.commitFile(box, box.web, 'web/page.test.js', "import { test } from 'node:test';\ntest('clause 1: renders', () => {});\n", 'feat(web): page test [G1]').status, 0);
  const ticked = await box.runLocal(box.web, 'fact', id, 'note', 'clause 1 [test]: web/page.test.js "clause 1: renders" passes');
  assert.equal(ticked.code, 0, ticked.err);
  const submitted = await box.runLocal(box.web, 'submit', id, '--no-next');
  return submitted.out + submitted.err;
}

test('clause 1: with verify.failBefore unset, submit accepts a [test] clause that has no fail-before receipt [C7]', { timeout: 300_000 }, async t => {
  const said = await submitWithoutReceipt(t, undefined);
  assert.doesNotMatch(said, /fail-before|CLAUSE_UNTICKED/u);
});

test('clause 2: with verify.failBefore true, submit refuses a [test] clause that has no fail-before receipt [C7]', { timeout: 300_000 }, async t => {
  const said = await submitWithoutReceipt(t, true);
  assert.match(said, /CLAUSE_UNTICKED/u);
  assert.match(said, /fail-before, pass-after receipt/u);
});
