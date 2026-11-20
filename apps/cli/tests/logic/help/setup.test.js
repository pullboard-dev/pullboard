/** @pullboard-test-input apps/cli/src/logic/help/setup.js */
/** @pullboard-test-input apps/cli/src/logic/help.js */
/** The join and worktree usage lines show --level, and the flag table describes --level [C7,#10967]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELP_FLAG_EXPLANATIONS } from '../../../src/logic/help.js';
import { setupHelp } from '../../../src/logic/help/setup.js';

test('cli.logic-help-setup.worktree-and-join-usage-show-level-not-route: clause 1: the worktree and join usage lines show [--level light] and no [--route light] [C7,#10967]', () => {
  const lines = setupHelp.split('\n').filter(line => /pullboard (worktree|join) <lane>/u.test(line));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /\[--level light\]/u);
    assert.doesNotMatch(line, /\[--route light\]/u);
  }
});

test('cli.logic-help-setup.the-flag-table-describes-level-not-route: clause 2: the flag table describes --level with the text --route had [C7,#10967]', () => {
  assert.equal(HELP_FLAG_EXPLANATIONS['--level'], 'sets which work the model can take');
});
