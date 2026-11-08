/** Split a test run's selected files across free runner slots by recorded per-file time [C7]. */
import { planLandingShards } from './landing-shards.js';

/**
 * Plan the shards of one test run: the selected files split across the free runner slots, balanced
 * by each file's last recorded wall time (file count where none is recorded).
 * Why: it never takes more shards than there are free slots and never more than files, and with
 * one free slot (or one file) it returns a single shard holding every file in today's order, so a
 * run with no spare capacity is unchanged. A pure function: nothing reads or reserves a slot here.
 *
 * @param {string[]} files - The selected test files, in the order today's run uses.
 * @param {number} freeSlots - Free runner slots right now.
 * @param {Record<string, number>} [times] - Last wall time in ms by repository-relative path.
 * @param {string|null} [root] - Repository root, so absolute and relative spellings dedupe.
 * @returns {{ files: string[], weight: number }[]}
 */
export function planRunShards(files, freeSlots, times = {}, root = null) {
  const slots = Number.isInteger(freeSlots) ? Math.max(1, freeSlots) : 1;
  if (slots === 1 || files.length < 2) return [{ files: [...files], weight: files.length }];
  return planLandingShards(files, Math.min(slots, files.length), times, root);
}

/**
 * Decide how an ordinary (build, submit or review) test run splits across the runner slots free right now.
 * Why: a landing keeps its own fan-out and goes first in the queue, a shard of a run and a run already inside a runner
 * slot never split again, and `freeSlots` is read after the landings' holders and waiters, so a run takes only the
 * slots free once landings have theirs. Any of those cases, or one free slot, gives today's single pass.
 *
 * @param {{ files: string[], freeSlots: number, times?: Record<string, number>, root?: string|null,
 *   landing?: boolean, shard?: boolean, insideRunnerSlot?: boolean }} run
 * @returns {{ files: string[], weight: number }[]} One entry per shard; a single entry means no split.
 */
export function ordinaryRunShards({ files, freeSlots, times = {}, root = null, landing = false, shard = false, insideRunnerSlot = false }) {
  if (landing || shard || insideRunnerSlot) return [{ files: [...files], weight: files.length }];
  return planRunShards(files, freeSlots, times, root);
}

/**
 * Run an ordinary test run as shards on the runner slots free after landings, and say whether it did.
 * Why here: bin/run-tests.js stays one call and the gate, kernel and runner pieces arrive as parameters, so this cell
 * takes no new cross-cell import; a run inside a runner slot, with PULLBOARD_RUN_SHARDS=0, with one file or with fewer
 * than two free slots returns false and runs as it always did [C7].
 *
 * @param {object} run - The run-tests context plus the gate, kernel and runner functions it hands over.
 * @returns {Promise<boolean>} True when the shards ran and set the exit code.
 */
export async function runOrdinaryShards({ root, runner, fullSuite, actions, args, scopedMarker, browser, runnerAdmission, runnerOnly, timing, inheritedGateSlot, gate, parseProcessCensus, browserBoundFiles, readFileTimes, narrowsSelection, optionTakesValue, knownNodeOption, explicitTestFiles }) {
  if (process.env.PULLBOARD_RUN_SHARDS === '0' || (scopedMarker && inheritedGateSlot({ root, browser })?.runnerExecution === true)) return false;
  const files = actions.files ?? (fullSuite ? (gate.isGitWorkTree(root, process.env) ? gate.trackedDefaultTestFiles(root, process.env) : []) : explicitTestFiles(args));
  const plan = files.length < 2 ? [] : ordinaryRunShards({ files, freeSlots: gate.freeRunnerSlots(), times: readFileTimes(root), root });
  if (plan.length < 2) return false;
  const bound = new Set(await browserBoundFiles(root, files));
  const { runLandingShards } = await import('./landing-shards.js');
  const result = await runLandingShards({ root, runner, files, count: plan.length, inherited: null, parseProcessCensus, timing, runnerAdmission: { ...runnerAdmission, runnerOnly },
    fullScope: fullSuite && !narrowsSelection(actions.args, optionTakesValue),
    args: (gate.nativeFileArguments(actions.args, { files: Infinity }, knownNodeOption, optionTakesValue), gate.landingShardOptions(actions.args, optionTakesValue)),
    needsBrowser: async shardFiles => shardFiles.some(file => bound.has(file)) });
  timing.sharded(result, files);
  process.exitCode = result.isGreen ? 0 : 1;
  return true;
}
