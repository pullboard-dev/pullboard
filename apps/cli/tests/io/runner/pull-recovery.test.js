/** @pullboard-test-input source-tree */
/** A pull of 4 jobs leaves no controller process while waiting, the held-first-dispatch case yields, and registered SSH runner execution recovers inside a committed, secret-free worker checkout [C7,#5465,#5537,#6734]. */
import { definePullJourney } from '../../fixtures/runner/pull-journey.js';
import '../../fixtures/runner/lost-cases-held.js';
import '../../../journeys/runner/lost.test.js';
import { runnerHoldRecoveryTests } from '../../fixtures/scenarios/runners.js';
import { runnerInstallerRecoveryTests } from '../../fixtures/scenarios/runners.js';
import { runnerProbeRecoveryTests } from '../../fixtures/scenarios/runners.js';

definePullJourney(4);

runnerHoldRecoveryTests();

runnerInstallerRecoveryTests({ workerFirstCases: [true], custody: false });

runnerInstallerRecoveryTests({ workerFirstCases: [false] });

runnerProbeRecoveryTests([99]);

runnerProbeRecoveryTests([1]);
