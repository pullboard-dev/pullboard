/** verify.testAuthorSplit refuses a submit whose own seat wrote a bar-named test file; off by default [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorSplitProblem } from '../../index.js';
import { contentHash } from '../../index.js';

const item = { item_id: 7, item_criterion: '1. a/one.test.js passes [test]' };
const changed = { atHead: () => 'new test', atMain: () => 'old test', seat: 'core-1' };
const record = (seat, text) => ({ id: 1, type: 'fact', kind: 'note', text: `test author a/one.test.js: seat ${seat}, family anthropic, sha256 ${contentHash(text)}` });

test('verify.authorsplit.setting-off: clause 1: with verify.testAuthorSplit unset, a test file the submitting seat changed is accepted [C7]', () => {
  assert.equal(authorSplitProblem(undefined, item, [], changed), null);
  assert.equal(authorSplitProblem({}, item, [], changed), null);
  assert.equal(authorSplitProblem({ testAuthorSplit: false }, item, [], changed), null);
});

test('verify.authorsplit.same-seat: clause 2: with verify.testAuthorSplit true, that item is refused with TEST_AUTHOR_SAME_SEAT [C7]', () => {
  assert.equal(authorSplitProblem({ testAuthorSplit: true }, item, [], changed)?.code, 'TEST_AUTHOR_SAME_SEAT');
  assert.equal(authorSplitProblem({ testAuthorSplit: true }, item, [record('core-1', 'new test')], changed)?.code, 'TEST_AUTHOR_SAME_SEAT', 'own record still refused');
  assert.equal(authorSplitProblem({ testAuthorSplit: true }, item, [], { ...changed, atHead: () => 'old test' }), null, 'an unchanged test passes');
});

test('verify.authorsplit.other-author: clause 3: with verify.testAuthorSplit true, a different recorded author at the same content hash is accepted [C7]', () => {
  assert.equal(authorSplitProblem({ testAuthorSplit: true }, item, [record('core-2', 'new test')], changed), null);
  assert.equal(authorSplitProblem({ testAuthorSplit: true }, item, [record('core-2', 'other text')], changed)?.code, 'TEST_AUTHOR_SAME_SEAT', 'a stale hash is refused');
});
