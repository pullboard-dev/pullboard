/** Config light door [C7,D3]. */
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
  derivedStateEnabled,
  healthDiskFloorGb,
  hunkFreshnessEnabled,
  listThinRead,
  loadMachineSettings,
  namedImportSelectionOn,
  readThinCommands,
  reofferInfraEndEnabled,
  retireIdleSeatHours,
  submitProofOnly,
  typedFieldsEnabled,
  validateRunner,
} from './src/logic/settings.js';
