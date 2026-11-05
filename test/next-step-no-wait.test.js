/** No next: line of next, show, submit, claim or status suggests --wait; submit points at next --take [C7,#2905]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { successfulNext } from '../packages/config/src/core/json-output.js';
import { DEFAULT_NEXT_STEPS } from '../apps/cli/src/core/next-step-defaults.js';
import { refuseNextIdle } from '../apps/cli/src/shell/next-steps.js';

test('the default next step of every command is next --take, never a --wait hint [C7,#2905]', () => {
  for (const command of ['next', 'show', 'submit', 'claim', 'status', 'list'])
    assert.doesNotMatch(successfulNext(command, {}), /--wait/u, command);
  assert.equal(successfulNext('submit', {}), 'pullboard next --take');
});

test('an idle next names next --take, in its message and its next: line [C7,#2905]', () => {
  assert.doesNotMatch(DEFAULT_NEXT_STEPS.NOTHING_FREE, /--wait/u);
  const out = [];
  let refusal;
  refuseNextIdle({ refusal: (error) => { refusal = error; }, err: (line) => out.push(line) }, ['no item is free'], ['no item is free'], { minutes: 0, verify: false });
  assert.doesNotMatch(out.join('\n'), /--wait/u);
  assert.doesNotMatch(refusal.message, /--wait/u);
});
