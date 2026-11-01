/** Append periodic or release time summaries from the board's events and retained receipts [R1,R2,C7]. */
import { join } from 'node:path';
import { appendTimeCheckpoint, checkpointLine, readTimeHistory, timeStats, weeklyDue } from '../packages/stats/index.js';
import { retainedReceipts } from '../packages/gate/index.js';
import { events } from './board.js';

/** Record a due weekly checkpoint or a release checkpoint; return its path if one was appended. */
export function recordTimeCheckpoint(ctx, board, { reason, label, now = ctx.clock.now().getTime() }) {
  const file = join(ctx.info.commonDir, 'pullboard', 'stats-history.jsonl');
  if (reason === 'weekly' && !weeklyDue(readTimeHistory(file), now)) return null;
  const receipts = retainedReceipts(ctx.info.root, { from: '1970-01-01T00:00:00.000Z', to: new Date(now + 1).toISOString() });
  const stats = timeStats(events(board), { now, receipts });
  appendTimeCheckpoint(file, checkpointLine(stats, { reason, label }));
  return file;
}
