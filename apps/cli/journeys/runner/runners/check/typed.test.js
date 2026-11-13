/** Registered SSH runner long-missing-guard edge keeps its bounded typed diagnostic, split from check-guard.test.js to stay under its time budget [C7]. */
import {
  e2e,
  privateReviewRunnerEdges,
  test,
} from '../../../../tests/fixtures/scenarios/runners.js';

test('private runner long missing guard edge preserves public review behavior [C7,V4]', (t) => privateReviewRunnerEdges(t, e2e, 6, 7));
