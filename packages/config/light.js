/** Config light door [C7,D3]. */
export { configFromSource, loadConfig, environmentProblem } from './src/io/main.js';
export { gitSyncMarkerLinked } from './src/io/git/sync.js';
export { CONFIG_FILE, COORDINATOR, DOCTRINE_FILE, LEGACY_DOCTRINE_FILE, doctrineFile } from './src/io/main.js';
export { maintenanceDurations } from './src/logic/maintenance.js';
export { boardRemote } from './src/logic/settings.js';
export { loadMachineSettings, validateRunner } from './src/logic/settings.js';
export { listThinRead } from './src/logic/settings.js';
export { retireIdleSeatHours } from './src/logic/settings.js';
export { healthDiskFloorGb } from './src/logic/settings.js';
