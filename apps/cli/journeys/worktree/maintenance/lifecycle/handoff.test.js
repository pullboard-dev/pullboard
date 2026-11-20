/** The maintenance handoff lifecycle cases, split from maintenance/lifecycle.test.js to keep each file inside its budget [B3,C7]. @pullboard-test-input source-cell apps/cli */
import { registerMaintenanceCliHandoffTests } from '../../../../tests/fixtures/worktree/maintenance/lifecycle/handoff.js';
// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceCliHandoffTests();
