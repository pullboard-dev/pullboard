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
import { ordered } from './claim.js';

/**
 * Start an already-recorded request, recording an unavailable result if its child cannot start.
 * With `wait`, resolves to a promise that settles when the worker process has exited.
 */
export async function launchBaseline(ctx, board, id, baseline, options = {}) {
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

