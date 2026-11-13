/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: the drained-custody case and the fenced delayed installer. */
import {
  runnerInstallerRecoveryTests,
} from '../../../tests/fixtures/scenarios/runners.js';

runnerInstallerRecoveryTests({ workerFirstCases: [false] });
