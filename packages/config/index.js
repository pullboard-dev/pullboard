/** Named configuration front door preserving original bindings [C7,CD60]. */
export { configFromSource, loadConfig, environmentProblem } from './light.js';
export {
  commandDocs,
  declaredCommandShapes,
} from './src/io/declaration.js';
export {
  CONFIG_FILE,
  COORDINATOR,
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
  defaults,
  durationMs,
  configProblems,
  doctrineFile,
  frozenCheckCeilingMs,
  cadenceMilliseconds,
  DEFAULT_VIEW_PORT,
  defaultViewPort,
} from './src/io/main.js';
export { trunkRemote } from './src/io/trunk.js';
export { trunkProblems, configTrunkRemote } from './src/logic/trunk.js';
export {
  JSON_SHAPES,
} from './src/logic/json.js';
export {
  settingsInventory,
} from './src/io/settings/inventory.js';
export {
  loadMachineSettings,
  declaredMachineSlots,
  validateRunner,
  relayCanaryConfig,
  DEFAULT_RUNNER_WAIT_MS,
  validateRunnerWaitMs,
  validRunnerCpuLoad,
} from './src/logic/settings.js';
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
  runnerDispatchMode,
  pullPilot,
  pullGateFor,
  jobQueueMode,
  localRunnerEnabled,
  serveListen,
  mainComparisonMode,
  submitAuthorizationMode,
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
} from './src/io/settings.js';
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
} from './src/io/templates.js';
export {
  releaseHeadlinesBetween,
} from './src/io/headlines.js';
export {
  VERSION,
} from './src/logic/version.js';
export {
  gitSyncFiles,
  readGitSyncMarker,
  gitSyncMarkerLinked,
  gitSyncRecoveryNeeded,
  readGitSyncRepairs,
} from './src/io/git/sync.js';
export {
  SETTING_DESCRIPTIONS,
  CLI_SETTABLE,
  describeSetting,
} from './src/io/settings/descriptions.js';
export {
  knownConfigKeys,
} from './src/io/compat.js';
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
} from './browser.js';
export {
  maintenanceDefaults,
  maintenanceConfigProblems,
  maintenanceDurations,
} from './src/logic/maintenance.js';

export { clauseInspectionEnabled, setClauseInspection } from './src/io/settings.js';
export { boardKey, boardKeyFile } from './src/io/settings.js';
export { boardRemote, setBoardRemote } from './src/io/settings.js';
