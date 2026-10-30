/** Frozen maintenance check: private recovery, real engine lifecycle and native scheduling [B3,C7]. */
import { registerMaintenanceArchiveTests } from './worktree-maintenance-archive.fixture.js';
import { registerMaintenanceConfigTests } from './worktree-maintenance-config.fixture.js';
import { registerMaintenanceClassificationTests } from './worktree-maintenance-classify.fixture.js';
import { registerMaintenanceSchedulerTests } from './worktree-maintenance-scheduler.fixture.js';
import { registerMaintenanceEngineTests } from './worktree-maintenance-engine.fixture.js';
import { registerMaintenanceCliTests } from './worktree-maintenance-cli.fixture.js';
registerMaintenanceArchiveTests();
registerMaintenanceConfigTests();
registerMaintenanceClassificationTests();
registerMaintenanceSchedulerTests();
registerMaintenanceEngineTests();
registerMaintenanceCliTests();
