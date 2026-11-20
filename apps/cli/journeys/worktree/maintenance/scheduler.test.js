/** The maintenance scheduler cases (a real shipped CLI timer among them), split from worktree/maintenance.test.js to keep each file inside its budget [B3,C7]. @pullboard-test-input source-cell apps/cli */
import { registerMaintenanceSchedulerTests } from '../../../tests/fixtures/worktree/maintenance/scheduler.js';
// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceSchedulerTests();
