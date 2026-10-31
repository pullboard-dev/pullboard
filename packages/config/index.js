/** Named configuration front door preserving original bindings [C7,CD60]. */
export {
  commandDocs,
  declaredCommandShapes,
} from './src/shell/command-declaration-read.js';
export {
  CONFIG_FILE,
  COORDINATOR,
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
  defaults,
  durationMs,
  configProblems,
  loadConfig,
  doctrineFile,
  frozenCheckCeilingMs,
  configFromSource,
  environmentProblem,
  cadenceMilliseconds,
  DEFAULT_VIEW_PORT,
  defaultViewPort,
} from './src/shell/config.js';
export {
  JSON_SHAPES,
} from './src/core/json.js';
export {
  settingsInventory,
} from './src/shell/settings-inventory.js';
export {
  loadMachineSettings,
  validateRunner,
  relayCanaryConfig,
  DEFAULT_RUNNER_WAIT_MS,
  validateRunnerWaitMs,
  validRunnerCpuLoad,
} from './src/core/settings-read.js';
export {
  gateQueueSettings,
  browserFreeChecksEnabled,
  gateRunnersFirstEnabled,
  postLandSuiteEnabled,
  gateRunnerAdmission,
  setGateRunnersOnly,
  gateRunnerWaitMs,
  parseWorkerBudget,
  workerBudget,
  setWorkerBudget,
  setGateRunnerWaitMs,
  browserByLaunchEnabled,
  viewBackgroundEnabled,
  healthSentinelEnabled,
  memoryFloorMB,
  relayOfferEnabled,
  setRelayCanary,
  setLandingPool,
  setGateSlots,
  gateShortSlots,
  setGateShortSlots,
  setBrowserSlots,
  setGateRunnersFirst,
  setGateMeasuredSlots,
  setGateLoadDispatch,
  addRunner,
  recordRunnerMeasurement,
  removeRunner,
  machineSettingsFile,
} from './src/shell/settings.js';
export {
  AGENTS_START,
  AGENTS_END,
  configTemplate,
  specTemplate,
  practiceTemplate,
  renderAgentsBlock,
  PULLBOARD_LOOP_GIT_COMMANDS,
  plainGateWords,
  claudeLoopRules,
  codexLoopRules,
  BOARD_PROOF_GUIDANCE,
} from './src/shell/templates.js';
export {
  releaseHeadlinesBetween,
} from './src/shell/release-headlines.js';
export {
  VERSION,
} from './src/core/release-version.js';
export {
  gitSyncFiles,
  readGitSyncMarker,
  gitSyncMarkerLinked,
  gitSyncRecoveryNeeded,
  readGitSyncRepairs,
} from './src/shell/git-sync-files.js';
export {
  SETTING_DESCRIPTIONS,
  CLI_SETTABLE,
  describeSetting,
} from './src/shell/settings-descriptions.js';
export {
  knownConfigKeys,
} from './src/shell/config-forward-compat.js';
export {
  exitRulesDefaults,
  exitRulesConfigProblems,
  mergeExitRules,
  COORDINATOR_PERSON_REQUEST,
  personRequestStep,
  personRequestGuidance,
  versionedRefusal,
  DEFAULT_OUTPUT_BUDGET,
  OUTPUT_BUDGETS,
  commandName,
  interactiveNext,
  successfulNext,
  LINE_BUDGET,
  cutLine,
  outputBudget,
  requestedFields,
  selectFields,
  commandOutput,
  validateCostPrices,
  usageDollars,
  localUsage,
  dollarText,
} from './core.js';
export {
  maintenanceDefaults,
  maintenanceConfigProblems,
  maintenanceDurations,
} from './src/core/worktree-maintenance-config.js';
