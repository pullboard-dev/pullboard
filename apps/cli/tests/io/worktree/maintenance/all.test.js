/** @pullboard-test-input source-cell apps/cli */
/** Maintenance: private recovery, real engine lifecycle, join, retention, CLI lifecycle and native scheduling, no dirty removal and no join in item folders [B3,C7]. */
import { registerMaintenanceArchiveTests } from '../../../fixtures/worktree/maintenance/archive.js';
import { registerMaintenanceConfigTests } from '../../../../../../packages/config/tests/fixtures/maintenance.js';
import { registerMaintenanceClassificationTests } from '../../../fixtures/worktree/maintenance/classify.js';
import { registerMaintenanceCliTests } from '../../../fixtures/worktree/maintenance.js';
import { registerMaintenanceEngineTests } from '../../../fixtures/worktree/maintenance/engine.js';
import { registerMaintenanceJoinTests } from '../../../fixtures/worktree/maintenance/join.js';
import { registerMaintenanceRetentionTests } from '../../../fixtures/worktree/maintenance/retention.js';
import { registerMaintenanceCliLifecycleTests } from '../../../fixtures/worktree/maintenance/lifecycle.js';
import { registerMaintenanceCliHandoffTests } from '../../../fixtures/worktree/maintenance/lifecycle/handoff.js';
import { registerMaintenanceSchedulerTests } from '../../../fixtures/worktree/maintenance/scheduler.js';

// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceArchiveTests();
registerMaintenanceConfigTests();
registerMaintenanceClassificationTests();
registerMaintenanceCliTests();
registerMaintenanceEngineTests();
registerMaintenanceJoinTests();
registerMaintenanceRetentionTests();
registerMaintenanceCliLifecycleTests();
registerMaintenanceCliHandoffTests();
registerMaintenanceSchedulerTests();
