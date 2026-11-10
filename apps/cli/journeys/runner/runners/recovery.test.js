/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  runnerRecoveryTests,
} from '../../../tests/fixtures/scenarios/runners.js';

runnerRecoveryTests();
