/** `pullboard stats review`: review queue depth by hour, time from submit to verdict and reject rate per reviewer family, read-only over the board [C7,#6138]. */
import {
  flowWindowMinutes,
  readReviewFlow,
  reviewFlow,
  reviewFlowLines,
} from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { withBoard } from '../../entry.js';

/** Parse an ISO UTC instant, refusing anything else. */
function instant(value) {
  const ms = Date.parse(String(value));
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(String(value)) || !Number.isFinite(ms)) throw new Refused('USAGE', '--until takes an ISO UTC time, for example --until 2026-11-12T10:00:00Z');
  return ms;
}

/**
 * Run `pullboard stats review` and return its exit code.
 *
 * Why: it only reads verdict rows, events and reservations the board already holds, so it measures the review loop without changing it.
 */
export function runReview(io, ctx, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.since !== undefined || values.compare) {
    throw new Refused('USAGE', 'show the review loop with pullboard stats review [--window 24h] [--until <ISO time>] [--json]');
  }
  const until = values.until === undefined ? ctx.clock.now().getTime() : instant(values.until);
  const from = until - flowWindowMinutes(values.window ?? '24h') * 60_000;
  const review = withBoard(ctx, board => reviewFlow(readReviewFlow(board.db, { until }), { from, until }));
  io.result?.({ review });
  for (const line of reviewFlowLines(review)) io.say(line);
  return 0;
}
