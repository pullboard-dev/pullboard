/** claim and release each have p50 under one second at real board size [C7,#3019]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  measureClaimRelease,
  slowCommands,
} from '../../tests/fixtures/size-budget.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: claim and release each have p50 under 1 s on the real-size board, printed against a 200 ms goal [C7,#3019]', async t => {
  assert.deepEqual(slowCommands(t, await measureClaimRelease(helpers.project('true'))), [], 'every command has a p50 under 1 s');
});
