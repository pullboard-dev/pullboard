/** Config light door [C7,D3]. */
export { gitSyncMarkerLinked } from './src/io/git/sync.js';
export {
  CONFIG_FILE,
  COORDINATOR,
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
  configFromSource,
  doctrineFile,
  environmentProblem,
  loadConfig,
} from './src/io/main.js';
export { browserFreeChecksEnabled } from './src/io/settings.js';
export { maintenanceDurations } from './src/logic/maintenance.js';
export {
  boardRemote,
  healthDiskFloorGb,
  listThinRead,
  loadMachineSettings,
  namedImportSelectionOn,
  retireIdleSeatHours,
  submitProofOnly,
  validateRunner,
} from './src/logic/settings.js';
