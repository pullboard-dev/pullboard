/** Registered SSH runner applied-guard and long-check edges keep public review behavior, split from check-guard.test.js to stay under its time budget [C7]. */
import {
  e2e,
  privateReviewRunnerEdges,
  test,
} from '../../../../tests/fixtures/scenarios/runners.js';

test('private runner applied guard and long-check edges preserve public review behavior [C7,V4]', (t) => privateReviewRunnerEdges(t, e2e, 7));
