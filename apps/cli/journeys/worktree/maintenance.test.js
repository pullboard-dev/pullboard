/** Frozen maintenance check: private recovery, real engine lifecycle and native scheduling, no dirty removal and no join in item folders [B3,C7]. */
import { registerMaintenanceArchiveTests } from '../../tests/fixtures/worktree/maintenance/archive.js';
import { registerMaintenanceConfigTests } from '../../../../packages/config/tests/fixtures/maintenance.js';
import { registerMaintenanceClassificationTests } from '../../tests/fixtures/worktree/maintenance/classify.js';
import { registerMaintenanceSchedulerTests } from '../../tests/fixtures/worktree/maintenance/scheduler.js';
import { registerMaintenanceCliTests } from '../../tests/fixtures/worktree/maintenance.js';
// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceArchiveTests();
registerMaintenanceConfigTests();
registerMaintenanceClassificationTests();
registerMaintenanceSchedulerTests();
registerMaintenanceCliTests();
