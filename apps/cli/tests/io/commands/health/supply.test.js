/** Health reports NO_REVIEWER_SUPPLY naming the family needed when declared limits leave no reviewer [C7,O2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { seedLimitedReviewQueue } from '../../../../../../packages/board/tests/fixtures/cell-board.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.journeys-health-supply.a-queue-with-only-same-family: clause 1: a queue with only same-family declared seats reports NO_REVIEWER_SUPPLY naming the family needed [C7,O2]', async () => {
  const box = e2e.project(undefined, undefined, { withWorktree: false });
  const id = seedLimitedReviewQueue(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { lane: 'web', family: 'Fixture-Builder', reviewers: 2 });
  const health = await box.runLocal(box.repo, 'health', '--json');
  const found = JSON.parse(health.out).stuck.find(entry => entry.cause === 'NO_REVIEWER_SUPPLY');
  assert.ok(found, `health reports the shortage: ${health.out}`);
  assert.equal(found.item, id);
  assert.match(found.why, /other than fixture-builder/iu);
  assert.match(found.next, /other than fixture-builder/iu);
});
