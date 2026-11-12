/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: the delayed-installer and drained-custody cases, each a real worker launch. */
import {
  runnerInstallerRecoveryTests,
} from '../../../tests/fixtures/scenarios/runners.js';

runnerInstallerRecoveryTests();
