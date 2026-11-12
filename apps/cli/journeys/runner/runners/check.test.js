/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  e2e,
  privateReviewRunnerCase,
  privateReviewRunnerEdges,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('a review check runs on a runner at the exact commit with trusted policy and full artifacts [C7,V4]', (t) => privateReviewRunnerCase(t, e2e));

test('private runner install, deadline and guard edges preserve public review behavior [C7,V4]', (t) => privateReviewRunnerEdges(t, e2e, 0, 4));
