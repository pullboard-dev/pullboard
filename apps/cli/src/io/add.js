/** Argument and lane helpers for `pullboard add` and `pullboard edit`. Split from src/cli.js, which re-exports it [C7]. */
import { main } from './main.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { outOfLane } from '../../../../packages/seats/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { briefFiles } from '../../../../packages/items/index.js';
import { startCheckBaseline } from '../../../../packages/gate/heavy.js';
import { runnerBaselineCommand } from '../../../../packages/gate/heavy.js';
import { offerCheckBaseline } from '../../../../packages/api/light.js';
import { queueFor } from '../../../../packages/api/light.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { localRunnerEnabled } from '../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../packages/config/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { boardRunsReader } from '../../../../packages/store/index.js';
import { relayLinked } from '../../../../packages/link/index.js';
import { ensureLocalRunner } from './runner/local.js';
import { primaryCheckoutRoot } from './worktree.js';
import { ordered } from './claim.js';
import { textArg } from './read.js';
export { editAfter } from './read.js';
export { textArg } from './read.js';

/**
 * Queue the baseline as a runner job on this board: any runner, this machine's local runner included, runs the check at
 * main and posts its result, and the board records it on the item [#6560]. False when this machine holds no board to
 * queue on, as behind a relay link.
 */
function offerBaseline(ctx, board, id, baseline) {
  const root = ctx.info.root;
  if (relayLinked(root) || !board?.db) return false;
  offerCheckBaseline(board.db, { item: id, expected: baseline, command: runnerBaselineCommand(root, baseline), queue: queueFor(board, 'coordinator', { file: ctx.file }) });
  return true;
}

/**
 * Offer the baseline as a pull job for this machine's local runner, which runs the check at main and posts its result.
 * With no registered runners the machine is its own runner, as for a gate [P7]; the check never runs on this host (#2520, #3851).
 * Why not the detached worker: it has no runner of its own to run the check on, so the baseline stayed pending forever (#6560).
 * Only under gate.runnerDispatch pull, as for a hosted landing: under controller nothing here pulls the job, so a
 * waited add sat out the whole wait and left a detached local runner behind (#6233).
 *
 * @returns {Promise<boolean>} True when the job is offered and the local runner runs; false leaves the baseline to the worker.
 */
async function offerLocalBaseline(ctx, board, id, baseline) {
  if (runnerDispatchMode() !== 'pull' || !localRunnerEnabled()) return false;
  const host = primaryCheckoutRoot(ctx.info);
  if (!host || !offerBaseline(ctx, board, id, baseline)) return false;
  return (await ensureLocalRunner(host)).running;
}

// Budget: a waited add holds for its pulled baseline this long, then returns it pending for a later `show` to read.
const BASELINE_WAIT_MS = 120_000;

/** Resolve once the item's baseline is no longer pending, or after BASELINE_WAIT_MS. */
async function settled(board, id) {
  for (const until = Date.now() + BASELINE_WAIT_MS; Date.now() < until;) {
    if (getItem(board, id)?.item_check_baseline?.result !== 'pending') return;
    await new Promise(done => setTimeout(done, 250));
  }
}

/**
 * Whether a runner serve pulls this board's queue: one claimed a job here within SERVE_RECENT_MS, as the board's one
 * serve reading counts it. Why: a runner registered with `pullboard runner add` and no `runner install-serve` takes work
 * only over ssh and never pulls the queue, so a baseline queued for it stayed pending forever and a waited add sat silent
 * for BASELINE_WAIT_MS (#10844). An unreadable queue reads as pulled, so a read failure never starts a worker per add (#10787).
 * Why lazy: the runners package loads only when an add or edit records a baseline with runners registered.
 */
async function servePullsQueue(ctx, board) {
  let runs = null;
  try {
    const { readPulledCapacity } = await import('../../../../packages/runners/index.js');
    const reader = boardRunsReader(board, ctx.file);
    runs = reader ? { db: reader.db } : null;
    return readPulledCapacity(board.db, { runs }).totals.serves > 0;
  } catch { return true; } finally { try { runs?.db?.close(); } catch { /* a read-only handle */ } }
}

/**
 * Start an already-recorded request where the lib launcher routes it, recording an unavailable result if it cannot start:
 * with gate.runnersOnly on or any registered runner it is a runner job and nothing starts on this machine [#10787].
 * Registered runners with no serve pulling the queue get the detached worker, which measures on a registered runner
 * over ssh; queued, the job would wait for a serve that never comes [#10844].
 * With runners off it is a job for this machine's one local runner; no detached worker starts, as it has no runner to use.
 * A pulled job has no process here, so `wait` waits for its result; a worker's `wait` settles when that worker exits.
 * Why lazy: the launcher loads only when an add or edit records a baseline, so neither command's cold path grows.
 */
export async function launchBaseline(ctx, board, id, baseline, options = {}) {
  const { launchCheckBaseline, BASELINE_WORKER } = await (await import('../../../lib/light.js')).checkBaselineLauncher();
  const root = ctx.info.root;
  const settings = loadMachineSettings();
  const pulled = (settings.runners ?? []).length ? await servePullsQueue(ctx, board) : true;
  try {
    const launched = await launchCheckBaseline({ id, baseline }, {
      settings,
      offer: () => { if (!pulled) return false; try { return offerBaseline(ctx, board, id, baseline); } catch { return false; } },
      local: () => offerLocalBaseline(ctx, board, id, baseline).catch(() => false),
      spawn: () => startCheckBaseline(root, id, baseline, { ...options, worker: BASELINE_WORKER }),
    });
    if (launched.route === 'runner-job' || launched.route === 'local-runner') return options.wait ? settled(board, id) : undefined;
    return launched.exited;
  } catch {
    await ordered(ctx, board, 'completeCheckBaseline', [id, { agentId: COORDINATOR, expected: baseline,
      baseline: { command: baseline.command, main: baseline.main, result: 'unavailable', reason: 'background worker could not start; set --check again from the coordinator' } }]);
  }
}
/**
 * The brief a command was given, from --brief or --brief-file.
 *
 * @param {any} io
 * @param {any} values
 * @returns {string | undefined}
 */
export const briefArg = (io, values) => textArg(io, values, 'brief');
/**
 * Refuse a build item in a lane that owns no files, such as review: whoever claims it there can
 * commit nothing, so the item strands its builder. A review item, one that waits on the work it
 * reviews with --after, still goes there. The refusal names the lanes that own files [I1].
 * Until some lane owns files, as right after init, there is nowhere else to point, so the item is
 * added as before.
 *
 * @param {any} config
 * @param {string} lane
 * @param {number[]} after
 */
export function buildInFilelessLane(config, lane, after) {
  const owns = (name) => (config.lanes[name]?.owns ?? []).length > 0;
  if (lane === COORDINATOR || owns(lane) || after.length) return;
  const owning = Object.keys(config.lanes).filter(owns);
  if (!owning.length) return;
  throw new Refused('NO_FILES_LANE', `the ${lane} lane owns no files, so a build item there strands its builder; file it in a lane that owns files (${owning.join(', ')}), or pass --after <id> if it reviews that item`);
}

/**
 * A brief whose Files section stays inside the item's lane (B14), so a builder working from it
 * never runs into the lane check: an item's files sit in its lane.
 * With laneMode off the lane folders are only labels and the claimed item's cells are its own, so any brief stands [C7,#10843].
 *
 * @param {any} ctx
 * @param {string} lane
 * @param {string} brief
 * @returns {string}
 */
export function briefInLane(ctx, lane, brief) {
  if (ctx.config.laneMode === 'off') return brief;
  const foreign = outOfLane(ctx.config, lane, briefFiles(brief));
  if (foreign.length) {
    throw new Refused('BRIEF_LANE', `the brief names files outside the ${lane} lane: ${foreign.join(', ')}; split the item by lane, or wait on the other lane's item with --after`);
  }
  return brief;
}

