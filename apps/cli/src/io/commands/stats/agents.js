/** `pullboard stats agents`: per-seat claims, submits and landings per hour, and the most items held at once, read-only over the board [C7,#6136]. */
import {
  agentFlow,
  agentFlowLines,
  flowWindowMinutes,
  readAgentFlowEvents,
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
 * Run `pullboard stats agents` and return its exit code.
 *
 * Why: it only counts what the board already recorded, so it measures a trial without changing it.
 */
export function runAgents(io, ctx, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.since !== undefined || values.compare) {
    throw new Refused('USAGE', 'show per-seat flow with pullboard stats agents [--window 24h] [--until <ISO time>] [--json]');
  }
  const until = values.until === undefined ? ctx.clock.now().getTime() : instant(values.until);
  const from = until - flowWindowMinutes(values.window ?? '24h') * 60_000;
  const agents = withBoard(ctx, board => agentFlow(readAgentFlowEvents(board.db, { until }), { from, until }));
  io.result?.({ agents });
  for (const line of agentFlowLines(agents)) io.say(line);
  return 0;
}
