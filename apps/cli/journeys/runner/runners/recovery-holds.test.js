/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: the alternate-runner admission case and the in-memory hold cases. */
import {
  runnerHoldRecoveryTests,
} from '../../../tests/fixtures/scenarios/runners.js';

runnerHoldRecoveryTests();
