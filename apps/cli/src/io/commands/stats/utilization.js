/** pullboard stats runners --utilization: busy slots over total slots, from the board's job history, read only [C7,#6032]. */
import { runnerUtilization } from '../../../../../../packages/stats/index.js';
import { utilizationLines } from '../../../../../../packages/stats/index.js';
import { readJobSpans } from '../../../../../../packages/stats/index.js';
import { flowWindowMinutes } from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { context } from '../../entry.js';
import { withBoard } from '../../entry.js';

/** Run the utilization view and return its exit code. */
export function runUtilization(io, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.since !== undefined || values.compare) throw new Refused('USAGE', 'show runner utilization with pullboard stats runners --utilization [--window 24h] [--json]');
  const ctx = context(io);
  const now = ctx.clock.now().getTime();
  const windowMinutes = flowWindowMinutes(values.window ?? '24h');
  const report = withBoard(ctx, board => runnerUtilization(readJobSpans(board.db, { since: now - windowMinutes * 60_000, now }).spans, { now, windowMinutes }));
  io.result?.({ runnersUtilization: report });
  for (const line of utilizationLines(report)) io.say(line);
  return 0;
}
