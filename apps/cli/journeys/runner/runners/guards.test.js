/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  runnerSourceRefusalCases,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('current source refuses private, oversized and unsupported blobs before SSH [C7,S1]', runnerSourceRefusalCases);
