/** Browser-safe pure configuration and output policies: no node: built-in, no shell [C7,D3]. */
export {
  exitRulesDefaults,
  exitRulesConfigProblems,
  mergeExitRules,
} from './src/core/exit-rules-config.js';
export {
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
} from './src/core/json-output.js';
export {
  validateCostPrices,
  usageDollars,
  localUsage,
  dollarText,
} from './src/core/cost-prices.js';
