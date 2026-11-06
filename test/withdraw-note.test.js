/** @pullboard-test-input source-tree */
/** withdraw's refusal names the positional reason form and --note is accepted as the reason [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

test('clause 1: withdraw with no reason shows the positional form and --note is accepted as the reason [C7]', async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'First withdraw probe', '--criterion', 'A marker exists', '--check', 'test -f web/a').code, 0);
  assert.equal(box.run(box.repo, 'add', 'web', 'Second withdraw probe', '--criterion', 'A marker exists', '--check', 'test -f web/b').code, 0);
  const bare = box.run(box.repo, 'withdraw', '1');
  assert.notEqual(bare.code, 0, 'no reason refuses');
  const text = `${bare.out}${bare.err}`;
  assert.match(text, /NOTE_REQUIRED/u);
  assert.match(text, /pullboard withdraw 1 "<reason>"/u, 'the hint shows the positional form');
  const flagged = box.run(box.repo, 'withdraw', '2', '--note', 'Not needed any more');
  assert.equal(flagged.code, 0, `${flagged.out}${flagged.err}`);
});
