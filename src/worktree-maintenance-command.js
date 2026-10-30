/** Compose maintenance with native board readers and ordinary archive facts [B3,C7]. */
import { agentHandoff } from '../packages/state/src/core/handoff-state.js';
import { mainPolicy } from './trusted-policy.js';
import { listAgents } from './board.js';
import { listItems } from './board.js';
import { ordered } from './cli.js';
import { withBoard } from './cli.js';
import { withBoardRead } from './cli.js';
import { withLocalSeatPresence } from './seat-presence.js';
import { cleanMaintenanceSeat } from './worktree-maintenance.js';

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
  };
}

/** Optional housekeeping cannot turn an already-recorded lifecycle move into a false command failure. */
export async function cleanupMaintenanceLifecycle(ctx, agentId, details) {
  if (ctx.config.worktreeMaintenance?.enabled !== true) return null;
  try {
    const accepted = mainPolicy(ctx.info.root).config;
    return await cleanMaintenanceSeat(ctx.info.root, accepted,
      { ...maintenanceCommandPorts(ctx, agentId), completedTakeover: details.completedTakeover === true }, details);
  } catch {
    ctx.io.err('maintenance kept the worktree because its archive or custody could not be confirmed');
    return null;
  }
}
