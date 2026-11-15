/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: the delayed installer that wins its claim, a real worker launch. */
import {
  runnerInstallerRecoveryTests,
} from '../../../tests/fixtures/scenarios/runners.js';

runnerInstallerRecoveryTests({ workerFirstCases: [true], custody: false });
