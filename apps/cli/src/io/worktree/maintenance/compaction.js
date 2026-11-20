/** Routine maintenance compacts the board once a day and reports the file's bytes before and after [C7]. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { archiveOldEvents } from '../../../../../../packages/store/index.js';
import { compactJobSteps } from '../../../../../../packages/store/index.js';
import { archiveEventsEnabled } from '../../../../../../packages/config/index.js';
import { withBoard } from '../../entry.js';
import { maintenanceDirectory } from './observation.js';
import { fileSystemAdapter } from '../../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** One day: the least time between two compactions of the same board. */
export const COMPACTION_EVERY_MS = 86_400_000;
const FILE = 'board-compaction.json';

/** The last compaction this repository recorded, or null when none ran or the record is unreadable. */
function lastCompaction(directory) {
  try {
    const value = JSON.parse(fs.readFile(join(directory, FILE), 'utf8'));
    return Number.isFinite(Date.parse(value?.at)) ? value : null;
  } catch { return null; }
}

/**
 * Compact the board's old job steps, and archive the events of long-verified items when board.archiveEvents is on, unless one ran in the last day, and say what it did. A failure never stops the
 * worktree sweep that called this: the report names it and the next run tries again.
 * Why a record beside the maintenance state: the timer fires hourly and a vacuum rewrites the whole board file, so the
 * day's limit has to survive between processes.
 *
 * @param {object} ctx the command context
 * @param {{ now?: number, compact?: (board: any) => ReturnType<typeof compactJobSteps> }} [options]
 * @returns {{ ran: boolean, at: string, nextAt: string, rows?: number, jobs?: number, before?: number, after?: number, archiveBytes?: number, events?: number, error?: string }}
 */
export function dailyBoardCompaction(ctx, { now = Date.now(), compact = board => compactJobSteps(board.db) } = {}) {
  let directory;
  try { directory = maintenanceDirectory(ctx.info.commonDir); }
  catch (error) { return { ran: false, at: new Date(now).toISOString(), nextAt: new Date(now + COMPACTION_EVERY_MS).toISOString(), error: error.message }; }
  const last = lastCompaction(directory);
  if (last && now - Date.parse(last.at) < COMPACTION_EVERY_MS) return { ...last, ran: false, nextAt: new Date(Date.parse(last.at) + COMPACTION_EVERY_MS).toISOString() };
  try {
    const result = withBoard(ctx, board => {
      const steps = compact(board);
      return { ...steps, events: archiveOldEvents(board, new Date(now), { enabled: archiveEventsEnabled() }).moved };
    });
    const record = { ran: true, at: new Date(now).toISOString(), nextAt: new Date(now + COMPACTION_EVERY_MS).toISOString(),
      rows: result.rows, jobs: result.jobs, before: result.before, after: result.after, archiveBytes: result.archiveBytes, events: result.events };
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const descriptor = fs.open(temporary, 'wx', 0o600);
    try { fs.write(descriptor, JSON.stringify(record) + '\n'); } finally { fs.close(descriptor); }
    fs.rename(temporary, join(directory, FILE));
    return record;
  } catch (error) {
    return { ran: false, at: new Date(now).toISOString(), nextAt: new Date(now + 3_600_000).toISOString(), error: String(error?.message ?? error).slice(0, 300) };
  }
}

/** One line for the maintenance summary: the bytes before and after, or why nothing ran. */
export function compactionSummary(report) {
  if (report.error) return `board compaction: skipped (${report.error})`;
  if (!report.ran) return `board compaction: next at ${report.nextAt}`;
  return `board compaction: ${report.before} B to ${report.after} B (${report.rows} job steps of ${report.jobs} jobs archived, ${report.events ?? 0} events archived)`;
}
