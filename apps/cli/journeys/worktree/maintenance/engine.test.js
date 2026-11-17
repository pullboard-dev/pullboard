/** The maintenance engine, join and retention cases, split from worktree/maintenance.test.js to keep each file inside its budget [B3,C7]. @pullboard-test-input source-cell apps/cli */
import { registerMaintenanceEngineTests } from '../../../tests/fixtures/worktree/maintenance/engine.js';
import { registerMaintenanceJoinTests } from '../../../tests/fixtures/worktree/maintenance/join.js';
import { registerMaintenanceRetentionTests } from '../../../tests/fixtures/worktree/maintenance/retention.js';
// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceEngineTests();
registerMaintenanceJoinTests();
registerMaintenanceRetentionTests();
