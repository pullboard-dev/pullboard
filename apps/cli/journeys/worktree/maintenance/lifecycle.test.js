/** The maintenance CLI lifecycle cases (withdrawal and handoff cleanup), split from engine.test.js so each file fits its budget [B3,C7]. @pullboard-test-input source-cell apps/cli */
import { registerMaintenanceCliLifecycleTests } from '../../../tests/fixtures/worktree/maintenance/lifecycle.js';
// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceCliLifecycleTests();
