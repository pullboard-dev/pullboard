/** Ordinary test runs shard over the runner slots free after landings, called from bin/run-tests.js [C7]. */
/**
 * Run an ordinary test run as shards on the free runner slots when there are some, and say whether it did.
 * Why here: bin/run-tests.js stays one call; a landing, a shard and a run already inside a runner slot return false
 * and run as they always did, and a run with no spare slot after the landings' own does too [C7].
 *
 * @param {object} run - The run-tests context: root, runner, fullSuite, actions, args, scopedMarker, browser,
 *   runnerAdmission, runnerOnly, timing and the resources package's inheritedGateSlot.
 * @returns {Promise<boolean>} True when the shards ran and set the exit code.
 */
export async function runOrdinaryShards({ root, runner, fullSuite, actions, args, scopedMarker, browser, runnerAdmission, runnerOnly, timing, inheritedGateSlot }) {
  const gate = await import('../packages/gate/index.js');
  const insideRunnerSlot = scopedMarker ? inheritedGateSlot({ root, browser })?.runnerExecution === true : false;
  if (insideRunnerSlot || process.env.PULLBOARD_RUN_SHARDS === '0') return false;
  const files = actions.files ?? (fullSuite ? (gate.isGitWorkTree(root, process.env) ? gate.trackedDefaultTestFiles(root, process.env) : []) : gate.explicitTestFiles(args));
  if (files.length < 2) return false;
  const { ordinaryRunShards, runLandingShards } = await import('../packages/landing/index.js');
  const plan = ordinaryRunShards({ files, freeSlots: gate.freeRunnerSlots(), times: gate.readFileTimes(root), root });
  if (plan.length < 2) return false;
  const { parseProcessCensus } = await import('../packages/kernel/src/core/process-census.js');
  const bound = new Set(await gate.browserBoundFiles(root, files));
  const result = await runLandingShards({ root, runner, files, count: plan.length, inherited: null, parseProcessCensus, timing, runnerAdmission: { ...runnerAdmission, runnerOnly },
    fullScope: fullSuite && !gate.narrowsSelection(actions.args, gate.optionTakesValue),
    args: (gate.nativeFileArguments(actions.args, { files: Infinity }, gate.knownNodeOption, gate.optionTakesValue), gate.landingShardOptions(actions.args, gate.optionTakesValue)),
    needsBrowser: async shardFiles => shardFiles.some(file => bound.has(file)) });
  timing.sharded(result, files);
  process.exitCode = result.isGreen ? 0 : 1;
  return true;
}
