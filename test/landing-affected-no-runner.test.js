/** Legacy projects without affectedTests keep their configured gate through a real landing [C7]. */
import { after, test } from 'node:test';
import { assertBadgeLanding } from './badge-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('the README badge landing still runs its configured gate without affectedTests [C7]', () => {
  assertBadgeLanding(e2e);
});
