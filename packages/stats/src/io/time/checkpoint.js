/** Append periodic or release time summaries from the board's events and retained receipts [R1,R2,C7]. */
import { join } from 'node:path';
import { appendTimeCheckpoint } from './history.js';
import { STATS_HISTORY_FILE } from './history.js';
import { checkpointLine } from '../../logic/time.js';
import { readTimeHistory } from './history.js';
import { timeStats } from '../../logic/time.js';
import { weeklyDue } from '../../logic/time.js';

/** Record a due weekly checkpoint or a release checkpoint; return its path if one was appended. */
export function recordTimeCheckpoint(ctx, board, { reason, label, retainedReceipts, events, now = ctx.clock.now().getTime() }) {
  const file = join(ctx.info.commonDir, 'pullboard', STATS_HISTORY_FILE);
  if (reason === 'weekly' && !weeklyDue(readTimeHistory(file), now)) return null;
  const receipts = retainedReceipts(ctx.info.root, { from: '1970-01-01T00:00:00.000Z', to: new Date(now + 1).toISOString() });
  const stats = timeStats(events(board), { now, receipts });
  appendTimeCheckpoint(file, checkpointLine(stats, { reason, label }));
  return file;
}
