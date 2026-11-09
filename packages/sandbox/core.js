/** Sandbox light door: the environment, committed-policy and denial readers a test run or landing needs, without the cell's board and state closure [C7,V4]. */
export { executionEnvironment, environmentLabel, carriesLandingEnvironment, captureTestRuntimes, bindTestRuntime, testRuntimeImport } from './src/shell/execution-environment.js';
export { fileDenialWatcher, remoteFileDenial } from './src/shell/sandbox-denial.js';
export {
  policyGit,
  mainPolicy,
  policyAt,
  RUNNER_POLICY_FILE,
  validRunnerTrunk,
  runnerPolicyRecord,
  carriedRunnerTrunk,
  trunkRef,
} from './src/shell/trusted-policy-read.js';
