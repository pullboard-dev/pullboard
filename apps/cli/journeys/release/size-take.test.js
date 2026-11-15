/** next --take has a p50 under one second at real board size [C7,#3019]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  measureNext,
  slowCommands,
} from '../../tests/fixtures/size-budget.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
test('clause 1: next --take has a p50 under 1 s on the real-size board, printed against a 200 ms goal [C7,#3019]', async t => {
  assert.deepEqual(slowCommands(t, await measureNext(helpers.project('true'), 'next --take')), [], 'next --take has a p50 under 1 s');
});
