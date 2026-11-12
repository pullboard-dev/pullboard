/** `pullboard stats runners`: measurement of the runner fleet, read-only over the job tables [C7]. */
import {
  WAIT_STEP_NAMES,
  readLimitChanges,
  readRunnerJobs,
  runnerWaitLines,
  runnerWaits,
  waitRows,
} from '../../../../../../packages/stats/index.js';
import { flowWindowMinutes } from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { withBoard } from '../../entry.js';

/** Parse an ISO UTC instant, refusing anything else. */
function instant(value, flag) {
  const ms = Date.parse(String(value));
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(String(value)) || !Number.isFinite(ms)) throw new Refused('USAGE', `${flag} takes an ISO UTC time, for example ${flag} 2026-11-12T10:00:00Z`);
  return ms;
}

/**
 * Run `pullboard stats runners` and return its exit code: slot wait and queue depth per job kind and hour.
 *
 * Why: runner capacity drives speed, so the numbers come from the board's own job steps, never an assumption.
 */
export function runRunners(io, ctx, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.since !== undefined || values.compare) {
    throw new Refused('USAGE', 'show runner slot waits and queue depth with pullboard stats runners [--window 24h] [--until <ISO time>] [--json]');
  }
  const until = values.until === undefined ? ctx.clock.now().getTime() : instant(values.until, '--until');
  const from = until - flowWindowMinutes(values.window ?? '24h') * 60_000;
  const jobs = withBoard(ctx, board => readRunnerJobs(board.db, { from, until, steps: WAIT_STEP_NAMES }));
  const waits = runnerWaits(waitRows(jobs), { from, until });
  const limits = withBoard(ctx, board => readLimitChanges(board.db, { from, until }));
  io.result?.({ runners: { waits, limits } });
  for (const line of runnerWaitLines(waits)) io.say(line);
  return 0;
}
