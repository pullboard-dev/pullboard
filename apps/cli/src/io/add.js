/** Argument and lane helpers for `pullboard add` and `pullboard edit`. Split from src/cli.js, which re-exports it [C7]. */
import { dependencyValues } from '../../../../packages/items/index.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { main } from './main.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { outOfLane } from '../../../../packages/seats/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { briefFiles } from '../../../../packages/items/index.js';
import { startCheckBaseline } from '../../../../packages/gate/index.js';
import { runnerBaselineCommand } from '../../../../packages/gate/index.js';
import { offerCheckBaseline } from '../../../../packages/api/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { localRunnerEnabled } from '../../../../packages/config/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { relayLinked } from '../../../../packages/link/index.js';
import { ensureLocalRunner } from './runner/local.js';
import { primaryCheckoutRoot } from './worktree.js';
import { ordered } from './claim.js';

/**
 * Offer the baseline as a pull job for this machine's local runner, which runs the check at main and posts its result.
 * With no registered runners the machine is its own runner, as for a gate [P7]; the check never runs on this host (#2520, #3851).
 * Why not the detached worker: it has no runner of its own to run the check on, so the baseline stayed pending forever (#6560).
 *
 * @returns {Promise<boolean>} True when the job is offered and the local runner runs; false leaves the baseline to the worker.
 */
async function offerLocalBaseline(ctx, board, id, baseline) {
  const root = ctx.info.root;
  if (!localRunnerEnabled() || (loadMachineSettings().runners ?? []).length || relayLinked(root) || !board?.db) return false;
  const host = primaryCheckoutRoot(ctx.info);
  if (!host) return false;
  offerCheckBaseline(board.db, { item: id, expected: baseline, command: runnerBaselineCommand(root, baseline) });
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
 * Start an already-recorded request, recording an unavailable result if its child cannot start.
 * With no registered runner the baseline is a pulled job on the local runner and `wait` has nothing to wait for;
 * otherwise, with `wait`, resolves to a promise that settles when the worker process has exited.
 */
export async function launchBaseline(ctx, board, id, baseline, options = {}) {
  try { if (await offerLocalBaseline(ctx, board, id, baseline)) return options.wait ? settled(board, id) : undefined; } catch { /* the worker below leaves it pending */ }
  try { return await startCheckBaseline(ctx.info.root, id, baseline, options); }
  catch {
    await ordered(ctx, board, 'completeCheckBaseline', [id, { agentId: COORDINATOR, expected: baseline,
      baseline: { command: baseline.command, main: baseline.main, result: 'unavailable', reason: 'background worker could not start; set --check again from the coordinator' } }]);
  }
}
/** Parse an edit's dependency replacement, with the explicit word `none` meaning clear all. */
export function editAfter(text) {
  if (text === undefined) return undefined;
  if (text.trim() === 'none') return [];
  const parts = text.split(',').map((part) => part.trim());
  if (!text.trim() || parts.some((part) => !part || part === 'none')) {
    throw new Refused('USAGE', 'use --after <id>[,<id>...] or --after none');
  }
  return dependencyValues(parts);
}
/**
 * Text a command was given as --<name> "..." or as --<name>-file <file>, or undefined when neither.
 * A file carries text past the shell exactly: backticks, dollar signs and quotes included.
 *
 * @param {any} io
 * @param {any} values
 * @param {string} name
 * @returns {string | undefined}
 */
export function textArg(io, values, name) {
  const path = values[`${name}-file`];
  if (values[name] !== undefined && path !== undefined) {
    throw new Refused('USAGE', `give the ${name} once: --${name} "..." or --${name}-file <file>`);
  }
  if (path === undefined) return values[name];
  const file = resolve(io.cwd, path);
  if (!existsSync(file)) throw new Refused('NO_FILE', `no file ${path}`);
  return readFileSync(file, 'utf8');
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
 *
 * @param {any} ctx
 * @param {string} lane
 * @param {string} brief
 * @returns {string}
 */
export function briefInLane(ctx, lane, brief) {
  const foreign = outOfLane(ctx.config, lane, briefFiles(brief));
  if (foreign.length) {
    throw new Refused('BRIEF_LANE', `the brief names files outside the ${lane} lane: ${foreign.join(', ')}; split the item by lane, or wait on the other lane's item with --after`);
  }
  return brief;
}

