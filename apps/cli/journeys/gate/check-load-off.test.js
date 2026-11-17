/** With machine.holdHeavyAboveLoad off, pullboard check under the same load reports green with no wait line [C7,#10141]. @pullboard-test-input source-cell apps/cli packages/config packages/resources */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { WAIT_LINE } from '../../tests/fixtures/check-hold.js';
import { checkUnderLoad } from '../../tests/fixtures/check-hold.js';
import { e2e } from '../../tests/fixtures/check-hold.js';
import { holdSettings } from '../../tests/fixtures/check-hold.js';
import { seat } from '../../tests/fixtures/check-hold.js';

after(e2e.cleanup);

test('clause 2: with the setting off, the same check under the same load reports green and prints no wait line [C7,#10141]', { timeout: 180_000 }, async t => {
  const box = await seat();
  holdSettings(box, { holdHeavyAboveLoad: false });
  const answer = await checkUnderLoad(t, box);
  assert.equal(answer.result.code, 0, answer.result.out + answer.result.err);
  assert.match(answer.result.out, /check green in/u);
  assert.doesNotMatch(answer.seen, new RegExp(WAIT_LINE, 'u'));
});
