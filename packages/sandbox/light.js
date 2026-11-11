/** Sandbox light door: the environment, committed-policy and denial readers a test run or landing needs, without the cell's board and state closure [C7,V4]. */
export { executionEnvironment, environmentLabel, carriesLandingEnvironment, captureTestRuntimes, bindTestRuntime, testRuntimeImport } from './src/io/environment.js';
export { fileDenialWatcher, remoteFileDenial, sandboxBlockedOperation } from './src/io/denial.js';
export { spawnCaptured } from './src/io/captured.js';
export {
  policyGit,
  mainPolicy,
  policyAt,
  RUNNER_POLICY_FILE,
  validRunnerTrunk,
  runnerPolicyRecord,
  carriedRunnerTrunk,
  trunkRef,
} from './src/io/trusted/policy/committed.js';
