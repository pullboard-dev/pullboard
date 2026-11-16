/** @pullboard-test-input packages/gate/src/io/check/cla.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SENTENCE } from '../../../src/io/check/cla.js';
import { coAuthors } from '../../../src/io/check/cla.js';
import { evaluate } from '../../../src/io/check/cla.js';

const signed = { exempt: [], signatures: [{ login: 'old-name', id: 4242, comment_url: 'u', agreed_at: 't', cla_sha256: 'x' }] };
const base = { sha: 'abcdef1234', parents: ['p'], message: 'feat: x' };

/** A commit whose author renamed but kept the numeric id still matches the signature [C7]. */
test('a renamed login with the same numeric user id still matches its signature [C7]', () => {
  const result = evaluate({ commits: [{ ...base, login: 'new-name', id: 4242 }], comments: [] }, signed);
  assert.deepEqual(result.problems, []);
});

/** Someone who reuses a signed login under a different id is not the signer [C7]. */
test('the same login under a different numeric user id does not match [C7]', () => {
  const result = evaluate({ commits: [{ ...base, login: 'old-name', id: 9 }], comments: [] }, signed);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /old-name has not agreed/u);
});

/** Without an id on either side the lowercased login still decides [C7]. */
test('a commit with no id falls back to the login [C7]', () => {
  assert.deepEqual(evaluate({ commits: [{ ...base, login: 'OLD-NAME' }], comments: [] }, signed).problems, []);
});

/** The signing comment must come from the same user id as the commit author [C7]. */
test('the signing comment is matched by user id and recorded as a new signer [C7]', () => {
  const comments = [{ user_id: 7, login: 'renamed', body: SENTENCE, url: 'c' }];
  const ok = evaluate({ commits: [{ ...base, login: 'dev', id: 7 }], comments }, { exempt: [], signatures: [] });
  assert.equal(ok.newSigners.length, 1);
  const other = evaluate({ commits: [{ ...base, login: 'dev', id: 8 }], comments }, { exempt: [], signatures: [] });
  assert.equal(other.problems.length, 1);
});

/** A Co-authored-by trailer on a noreply address yields the id and login [C7]. */
test('co-author trailers parse the numeric id from a noreply address [C7]', () => {
  const found = coAuthors('subject\n\nCo-authored-by: Ann <55+ann@users.noreply.github.com>\nCo-Authored-By: Bob <bob@example.com>');
  assert.deepEqual(found.map((c) => [c.id, c.login]), [['55', 'ann'], [null, null]]);
});

/** An unsigned co-author refuses the check; a signed one passes [C7]. */
test('a commit with an unsigned Co-authored-by contributor is refused [C7]', () => {
  const commit = { ...base, login: 'old-name', id: 4242, message: 'x\n\nCo-authored-by: Ann <55+ann@users.noreply.github.com>' };
  const refused = evaluate({ commits: [commit], comments: [] }, signed);
  assert.equal(refused.problems.length, 1);
  assert.match(refused.problems[0], /ann has not agreed/u);
  const listed = { exempt: [], signatures: [...signed.signatures, { login: 'ann', id: 55 }] };
  assert.deepEqual(evaluate({ commits: [commit], comments: [] }, listed).problems, []);
});

/** A co-author whose email names no GitHub account cannot be matched, so the check refuses it [C7]. */
test('a co-author with a non-GitHub email is refused with a fix [C7]', () => {
  const commit = { ...base, login: 'old-name', id: 4242, message: 'x\n\nCo-authored-by: Bob <bob@example.com>' };
  const [problem] = evaluate({ commits: [commit], comments: [] }, signed).problems;
  assert.match(problem, /no GitHub login/u);
});
