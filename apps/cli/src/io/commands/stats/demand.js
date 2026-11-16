/** pullboard stats runners --demand: proof jobs and slot-minutes per active seat per hour, from the board's history, read only [C7,#6034]. */
import { boardRunsReader } from '../../../../../../packages/store/index.js';
import { runnerDemand } from '../../../../../../packages/stats/index.js';
import { demandLines } from '../../../../../../packages/stats/index.js';
import { readDemandSpans } from '../../../../../../packages/stats/index.js';
import { readDemandEvents } from '../../../../../../packages/stats/index.js';
import { flowWindowMinutes } from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { context } from '../../entry.js';
import { withBoard } from '../../entry.js';

/** Run the demand view and return its exit code. */
export function runDemand(io, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.since !== undefined || values.compare) throw new Refused('USAGE', 'show runner demand per agent with pullboard stats runners --demand [--window 24h] [--json]');
  const ctx = context(io);
  const now = ctx.clock.now().getTime();
  const windowMinutes = flowWindowMinutes(values.window ?? '24h');
  const since = now - windowMinutes * 60_000;
  const report = withBoard(ctx, board => {
    const { spans, created } = readDemandSpans(board.db, { since, now, runs: boardRunsReader(board, ctx.file) });
    return runnerDemand(spans, created, readDemandEvents(board.db, { since }), { now, windowMinutes });
  });
  io.result?.({ runnersDemand: report });
  for (const line of demandLines(report)) io.say(line);
  return 0;
}
