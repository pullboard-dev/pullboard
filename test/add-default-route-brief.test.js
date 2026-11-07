/** An add with no route and no brief is strong unless its check names a test file, which fills a mid brief [V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { onBoard } from './land-board-fixture.js';
import { fixtureAdd } from './testkit-fixture.js';

/** Add one item to a scratch project with no route and no brief, and read back its route and brief. */
function addWith(t, check) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Default route brief fixture';
  const box = helpers.project('true', isolated);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Small correction', '--criterion', 'the handler returns the canonical result [test]', '--check', check, '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  return onBoard(box, board => store.getItem(board, id));
}

test('clause 1: add with no route, no brief and a check naming no test file succeeds on the strong route [V4]', t => {
  const item = addWith(t, 'npm test');
  assert.equal(item.item_route, 'strong');
});

test('clause 2: add with no route whose check names a test file lands mid with Files and Test filled from the check [V4]', t => {
  const item = addWith(t, 'node --test web/handler.test.js');
  assert.equal(item.item_route, 'mid');
  assert.match(item.item_brief, /Files:\s*\n- web\/handler\.test\.js/u);
  assert.match(item.item_brief, /Test: web\/handler\.test\.js/u);
});
