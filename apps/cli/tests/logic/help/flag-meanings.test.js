/** @pullboard-test-input apps/cli/src/logic/help/flag-meanings.js */
/** The add --criterion help meaning names the evidence tags and the measurement number rule [C7,#12014]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFlag } from '../../../src/logic/help/flag-meanings.js';

const line = describeFlag('add', '--criterion "..."');

test('cli.logic-help-flag-meanings.criterion-names-tags: clause 1: the add --criterion meaning names the tags test, command, measurement and reasoning and says each numbered clause ends with exactly one tag [C7,#12014]', () => {
  for (const tag of ['[test]', '[command]', '[measurement]', '[reasoning]']) assert.ok(line.includes(tag), `names ${tag}`);
  assert.match(line, /each ending with exactly one tag/u);
  assert.match(line, /at most three numbered clauses/u);
});

test('cli.logic-help-flag-meanings.criterion-names-number-rule: clause 2: the add --criterion meaning says a measurement clause needs a number [C7,#12014]', () => {
  assert.match(line, /a \[measurement\] clause needs a number/u);
});
