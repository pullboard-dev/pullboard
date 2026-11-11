/** Compose maintenance with native board readers and ordinary archive facts [B3,C7]. */
import { agentHandoff } from '../../../../../../packages/state/index.js';
import { mainPolicy } from '../../../../../../packages/sandbox/index.js';
import { listAgents } from '../../../../../../packages/store/index.js';
import { listItems } from '../../../../../../packages/store/index.js';
import { ordered } from '../../entry.js';
import { withBoard } from '../../entry.js';
import { withBoardRead } from '../../entry.js';
import { withLocalSeatPresence } from '../../../../../../packages/store/index.js';
import { cleanMaintenanceSeat } from '../maintenance.js';
import { recordMaintenanceRetention } from './retention.js';

/** Imported heartbeat rows never grant permission to delete a local checkout. */
export function readMaintenanceSnapshot(ctx) {
  return withBoardRead(ctx, board => ({
    seats: withLocalSeatPresence(board, listAgents(board)).map(seat => ({ ...seat, createdAt: seat.agent_created_at,
      completedTakeoverAt: agentHandoff(board, seat.agent_id)?.takenAt ?? null })),
    items: listItems(board, { all: true }),
  }));
}

/** Keep board writes in the normal engine; the filesystem runner receives no database capability. */
export function maintenanceCommandPorts(ctx, agentId) {
  return {
    agentId,
    readSnapshot: () => readMaintenanceSnapshot(ctx),
    /** Complete every linked archive fact before the runner may reset or remove source. */
    recordArchive: record => withBoard(ctx, async board => {
      for (const item of [...new Set(record.items)]) {
        await ordered(ctx, board, 'appendFact', [item, { agentId, kind: 'note',
          text: `Worktree work archived before maintenance cleanup: ${JSON.stringify(record.path)}; archive ${JSON.stringify(record.archive)}; retained HEAD ${record.head} at ${record.ref}; snapshot ${record.signature}.` }]);
      }
    }),
    /** Name the kept folder and its dirty paths on every linked item, so the owner can find the unfinished work. */
    recordDirty: record => withBoard(ctx, async board => {
      const shown = record.paths.slice(0, 20).join(', ') + (record.paths.length > 20 ? `, and ${record.paths.length - 20} more` : '');
      for (const item of [...new Set(record.items)]) {
        await ordered(ctx, board, 'appendFact', [item, { agentId, kind: 'note',
          text: `Worktree kept by maintenance because it holds uncommitted changes: ${JSON.stringify(record.path)}; dirty paths: ${shown}.` }]);
      }
    }),
  };
}

/** Optional housekeeping cannot turn an already-recorded lifecycle move into a false command failure. */
export async function cleanupMaintenanceLifecycle(ctx, agentId, details) {
  if (ctx.config.worktreeMaintenance?.enabled !== true) return null;
  try {
    const accepted = mainPolicy(ctx.info.root).config;
    const result = await cleanMaintenanceSeat(ctx.info.root, accepted,
      { ...maintenanceCommandPorts(ctx, agentId), completedTakeover: details.completedTakeover === true,
        completedWithdrawal: details.completedWithdrawal === true && ctx.info.isMain && agentId === 'coordinator' }, details);
    if ((details.withdrawn || result?.clean) && accepted.worktreeMaintenance?.enabled === true) {
      await recordMaintenanceRetention(ctx.info.root, { ...details,
        reason: 'withdrawal cleanup deferred: checkout is protected, busy or still holds another obligation' }, { clear: Boolean(result?.clean) });
    }
    if (!result) ctx.io.err('maintenance kept the worktree because it is protected, busy or still holds another obligation');
    return result;
  } catch {
    ctx.io.err('maintenance kept the worktree because its archive or custody could not be confirmed');
    return null;
  }
}
