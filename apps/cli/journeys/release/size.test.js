/** next has a p50 under one second at real board size [C7,#3019]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  MAX_P50_MS,
  measureNext,
  p50,
  slowCommands,
} from '../../tests/fixtures/size-budget.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
test('cli.journeys-release-size.next-has-a-p50-under-1: clause 1: next has a p50 under 1 s on the real-size board, printed against a 200 ms goal [C7,#3019]', async t => {
  assert.deepEqual(slowCommands(t, await measureNext(helpers.project('true'), 'next')), [], 'next has a p50 under 1 s');
});

test('cli.journeys-release-size.the-budget-fails-when-any-command: clause 2: the budget fails when any command has a p50 of 1 s or more [C7,#3019]', () => {
  const slow = { next: [50, 60, 70], 'next --take': [900, 1000, 1100], claim: [10, 20, 30] };
  const over = Object.entries(slow).filter(([, values]) => !(p50(values) < MAX_P50_MS)).map(([name]) => name);
  assert.deepEqual(over, ['next --take'], 'only the command at 1 s or more fails the bar');
  assert.equal(p50([999, 1000, 1001]) < MAX_P50_MS, false, 'a p50 of exactly one second fails');
});
