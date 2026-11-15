import { maintenanceTimerWarning } from '../worktree/maintenance/diagnostics.js';
import { recordMaintenanceLastRun } from '../worktree/maintenance/diagnostics.js';
import { compactionSummary } from '../worktree/maintenance/compaction.js';
import { dailyBoardCompaction } from '../worktree/maintenance/compaction.js';
/** Repository maintenance is opt-in and runs from its real coordinator checkout [B3,C7]. */
import { actOn } from '../entry.js';
import { context } from '../entry.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { maintenanceCommandPorts } from '../worktree/maintenance/command.js';
import { maintenanceSummary } from '../worktree/maintenance.js';
import { runWorktreeMaintenance } from '../worktree/maintenance.js';

/** The scheduled timer holds no board connection, checkout lease or native gate while it waits. */
export async function run(io, { first, second, rest, values }) {
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard maintenance [--json]');
  const ctx = context(io);
  if (!ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'run pullboard maintenance from the main checkout');
  if (values.watch) {
    const { runScheduledMaintenance } = await import('../worktree/maintenance/scheduler.js');
    const scheduled = await runScheduledMaintenance(ctx, values.key);
    return scheduled.code ?? 0;
  }
  if (values.key !== undefined) throw new Refused('USAGE', '--key belongs only to the registered maintenance timer');
  const report = await actOn(io, async (opened, _board, me) =>
    runWorktreeMaintenance(opened.info.root, mainPolicy(opened.info.root).config, maintenanceCommandPorts(opened, me.id)));
  if (report.enabled) {
    try { recordMaintenanceLastRun(ctx.info.commonDir); }
    catch (error) { io.err(`maintenance last-run diagnostic unavailable: ${error.code ?? error.name}: ${error.message}`); }
  }
  // Routine maintenance also compacts the board's old job steps, at most once a day, and reports the bytes before and after [C7].
  if (report.enabled) report.compaction = dailyBoardCompaction(ctx);
  io.result?.(report);
  io.say(maintenanceSummary(report));
  if (report.compaction) io.say(compactionSummary(report.compaction));
  if (report.enabled) {
    const { scheduleWorktreeMaintenance } = await import('../worktree/maintenance/scheduler.js');
    try { await scheduleWorktreeMaintenance(ctx); }
    catch (error) { io.err(maintenanceTimerWarning(error)); }
  }
  return 0;
}
