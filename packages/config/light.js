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
export { maintenanceDurations } from './src/logic/maintenance.js';
export {
  boardRemote,
  browserFreeChecksEnabled,
  healthDiskFloorGb,
  listThinRead,
  loadMachineSettings,
  namedImportSelectionOn,
  readThinCommands,
  reofferInfraEndEnabled,
  retireIdleSeatHours,
  submitProofOnly,
  validateRunner,
} from './src/logic/settings.js';
