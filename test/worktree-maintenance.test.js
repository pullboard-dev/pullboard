/** Frozen maintenance check: private recovery, real engine lifecycle and native scheduling [B3,C7]. */
import { registerMaintenanceArchiveTests } from './worktree-maintenance-archive.fixture.js';
import { registerMaintenanceConfigTests } from '../packages/config/tests/worktree-maintenance-config.fixture.js';
import { registerMaintenanceClassificationTests } from './worktree-maintenance-classify.fixture.js';
import { registerMaintenanceSchedulerTests } from './worktree-maintenance-scheduler.fixture.js';
import { registerMaintenanceEngineTests } from './worktree-maintenance-engine.fixture.js';
import { registerMaintenanceCliTests } from './worktree-maintenance-cli.fixture.js';
import { registerMaintenanceCliLifecycleTests } from './worktree-maintenance-cli-lifecycle.fixture.js';
import { registerMaintenanceRetentionTests } from './worktree-maintenance-retention.fixture.js';
// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceArchiveTests();
registerMaintenanceConfigTests();
registerMaintenanceClassificationTests();
registerMaintenanceSchedulerTests();
registerMaintenanceEngineTests();
registerMaintenanceCliTests();
registerMaintenanceCliLifecycleTests();
registerMaintenanceRetentionTests();
