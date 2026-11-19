/** quotedPersonProblems refuses a line that quotes a configured person and passes a plain mention, a dated ruling citation and an empty names list [C7,#11300]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotedPersonProblems } from '../../src/logic/message.js';

test('commits.logic-message.quoted-person-refused: clause 1: quotedPersonProblems refuses a name followed by a colon and a quote, or by a speech verb and a quote, and passes a plain mention, a dated ruling citation and an empty names list [C7,#11300]', () => {
  const names = ['Sam'];
  for (const line of ['Sam: "ship it now"', 'sam said "ship it now"', 'SAM wrote, in passing, “ship it now”', 'Sam told us "no"', 'Sam asked: "why"', 'Sam replied "yes"', 'Sam ruled "closed"', 'the ruling from Sam, "closed"']) {
    const problems = quotedPersonProblems(`feat: one\n\n${line}`, names);
    const refused = !/ruling from/u.test(line);
    assert.equal(problems.length, refused ? 1 : 0, line);
    if (refused) assert.match(problems[0], /^line 3 quotes a configured person; state the rule itself or cite its item or spec id$/u);
  }
  for (const line of ['Sam reviewed the change', 'Sam ruled on 3 Nov that the setting stays off', 'Samuel said "hello"', 'the item cites Sam only by id']) {
    assert.deepEqual(quotedPersonProblems(line, names), [], line);
  }
  assert.deepEqual(quotedPersonProblems('Sam: "ship it now"', []), []);
  assert.deepEqual(quotedPersonProblems('Sam: "ship it now"', undefined), []);
});
