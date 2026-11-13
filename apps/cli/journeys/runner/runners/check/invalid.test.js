/** Registered SSH runner invalid-guard-path edge is rejected before a second dispatch, split from check-guard.test.js to stay under its time budget [C7]. */
import {
  e2e,
  privateReviewRunnerEdges,
  test,
} from '../../../../tests/fixtures/scenarios/runners.js';

test('private runner invalid guard path edge preserves public review behavior [C7,V4]', (t) => privateReviewRunnerEdges(t, e2e, 5, 6));
