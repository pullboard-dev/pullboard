/** Legacy projects without affectedTests keep their configured gate through a real landing [C7]. */
import {
  after,
  test,
} from 'node:test';
import { assertBadgeLanding } from '../../../tests/fixtures/badge.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('the README badge landing still runs its configured gate without affectedTests [C7]', () => {
  assertBadgeLanding(e2e);
});
