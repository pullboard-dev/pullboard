/** withdraw's refusal names the positional reason form and --note is accepted as the reason [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('clause 1: withdraw with no reason shows the positional form and --note is accepted as the reason [C7]', async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Withdraw note fixture';
  const box = helpers.project('true', isolated);
  for (const title of ['First withdraw probe', 'Second withdraw probe']) {
    const added = fixtureAdd(box.run, box.repo, 'web', title, '--criterion', 'A marker exists [test]', '--check', 'true');
    assert.equal(added.code, 0, `${added.out}${added.err}`);
  }
  const bare = box.run(box.repo, 'withdraw', '1');
  assert.notEqual(bare.code, 0, 'no reason refuses');
  const text = `${bare.out}${bare.err}`;
  assert.match(text, /NOTE_REQUIRED/u);
  assert.match(text, /pullboard withdraw 1 "<reason>"/u, 'the hint shows the positional form');
  const flagged = box.run(box.repo, 'withdraw', '2', '--note', 'Not needed any more');
  assert.equal(flagged.code, 0, `${flagged.out}${flagged.err}`);
});
