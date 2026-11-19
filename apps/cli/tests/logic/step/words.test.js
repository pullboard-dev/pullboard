/** No next: line of next, show, submit, claim or status suggests --wait; submit points at next --take [C7,#2905]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { successfulNext } from '../../../../../packages/config/index.js';
import { DEFAULT_NEXT_STEPS } from '../../../../../packages/state/index.js';
import { refuseNextIdle } from '../../../index.js';
import { nextStepFor } from '../../../src/logic/step/words.js';

test('cli.logic-step-words.the-default-next-step-of-every-command: the default next step of every command is next --take, never a --wait hint [C7,#2905]', () => {
  for (const command of ['next', 'show', 'submit', 'claim', 'status', 'list'])
    assert.doesNotMatch(successfulNext(command, {}), /--wait/u, command);
  assert.equal(successfulNext('submit', {}), 'pullboard next --take');
});

test('cli.logic-step-words.an-idle-next-names-next-take-in: an idle next names next --take, in its message and its next: line [C7,#2905]', () => {
  assert.doesNotMatch(DEFAULT_NEXT_STEPS.NOTHING_FREE, /--wait/u);
  const out = [];
  let refusal;
  refuseNextIdle({ refusal: (error) => { refusal = error; }, err: (line) => out.push(line) }, ['no item is free'], ['no item is free'], { minutes: 0, verify: false });
  assert.doesNotMatch(out.join('\n'), /--wait/u);
  assert.doesNotMatch(refusal.message, /--wait/u);
});

test('cli.logic-step-words.submit-path-steps-named: clause 1: nextStepFor returns the step a submit-path refusal message spells out (push, fetch, claim, start, submit again), never the service-owner fallback [C7,#2331]', () => {
  const cases = [
    ['COMMIT_NOT_PUSHED', 'abc123def456 is not pushed to the trunk remote; git push -u origin HEAD, then submit again', 'git push -u origin HEAD, then submit again'],
    ['NO_MAIN_REF', 'this clone has not fetched the host main; git fetch origin, merge origin/main, push and submit again', 'git fetch origin, merge origin/main, push and submit again'],
    ['REMOTE_REF_MISMATCH', 'refs/heads/x at the trunk remote is at aaa, which does not contain bbb; push bbb to refs/heads/x and submit again', 'push bbb to refs/heads/x and submit again'],
    ['COMMITS_REFUSED', 'the board host could not record abc123def456; submit again from the clone', 'submit again from the clone'],
    ['TEST_NO_CLAIM', 'agent holds 2 claims on the board at board.url; a test receipt records on exactly one; claim one with pullboard claim <id>, or run pullboard next', 'claim one with pullboard claim <id>, or run pullboard next'],
    ['TEST_JOB_UNCLAIMED', 'no runner took test job j within 30s; start one with pullboard runner serve <board-url>, then run pullboard test again', 'start one with pullboard runner serve <board-url>, then run pullboard test again'],
  ];
  for (const [code, message, step] of cases) {
    const next = nextStepFor({ code }, message);
    assert.equal(next, step, code);
    assert.doesNotMatch(next, /service owner/u, code);
  }
});

test('cli.logic-step-words.existing-steps-unchanged: clause 2: a clause that began with an existing repair word is still taken, and a message with no step still falls to its NEXT_STEPS row [C7,#2331]', () => {
  assert.equal(nextStepFor({ code: 'X_CODE' }, 'it broke; run pullboard status'), 'run pullboard status');
  assert.equal(nextStepFor({ code: 'NOTHING_FREE' }, 'no item is free'), DEFAULT_NEXT_STEPS.NOTHING_FREE);
});
