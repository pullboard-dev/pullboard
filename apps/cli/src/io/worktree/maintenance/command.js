/** Compose maintenance with native board readers and ordinary archive facts [B3,C7]. */
import { agentHandoff } from '../../../../../../packages/state/index.js';
import { lineSettings } from '../../../../../../packages/state/index.js';
import { SEAT_LIVE_WINDOW_MS } from '../../../../../../packages/store/index.js';
import { mainPolicy } from '../../../../../../packages/sandbox/index.js';
import { getItem } from '../../../../../../packages/store/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { goneMaintenanceSeat } from './classify.js';
import { listAgents } from '../../../../../../packages/store/index.js';
import { listItems } from '../../../../../../packages/store/index.js';
import { logEvent } from '../../../../../../packages/store/index.js';
import { ordered } from '../../entry.js';
import { withBoard } from '../../entry.js';
import { withBoardRead } from '../../entry.js';
import { withLocalSeatPresence } from '../../../../../../packages/store/index.js';
import { cleanMaintenanceSeat } from '../maintenance.js';
import { recordMaintenanceRetention } from './retention.js';

/** Imported heartbeat rows never grant permission to delete a local checkout. */
function localSeats(board) {
  return withLocalSeatPresence(board, listAgents(board)).map(seat => ({ ...seat, createdAt: seat.agent_created_at,
    completedTakeoverAt: agentHandoff(board, seat.agent_id)?.takenAt ?? null }));
}

/** The line's takeover window governs both claim release and folder custody. */
function takeoverWindow(board) {
  const minutes = lineSettings(board).takeoverMinutes;
  return typeof minutes === 'number' ? minutes * 60_000 : SEAT_LIVE_WINDOW_MS;
}

/** Read only native seat and item custody with the accepted line takeover window. */
export function readMaintenanceSnapshot(ctx) {
  return withBoardRead(ctx, board => ({
    seats: localSeats(board),
    items: listItems(board, { all: true }),
    takeoverMs: takeoverWindow(board),
  }));
}

/** Keep board writes in the normal engine; the filesystem runner receives no database capability. */
export function maintenanceCommandPorts(ctx, agentId) {
  return {
    agentId,
    readSnapshot: () => readMaintenanceSnapshot(ctx),
    /** Compare the captured claim revision in the native release, with a fresh process and heartbeat check before dispatch. */
    ...(ctx.info.isMain && agentId === 'coordinator' ? {
      releaseGoneClaim: (claim, seat, lastSeen, readDirectories) => withBoard(ctx, async board => {
        const revision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event WHERE item_id=?').get(claim.item_id).id;
        const args = [claim.item_id, agentId, '', { seat: seat.agent_id, lastSeen: new Date(lastSeen).toISOString(),
          checkout: { leaseUntil: claim.item_lease_until, itemRevision: revision } }, 'BLOCKED'];
        const directories = readDirectories();
        const prepareInWriter = current => {
          const latest = localSeats(current).find(row => row.agent_id === seat.agent_id);
          const item = getItem(current, claim.item_id);
          if (!latest || latest.agent_path !== seat.agent_path || item.item_status !== 'claimed' || item.item_owner !== seat.agent_id
            || item.item_lease_until !== claim.item_lease_until
            || goneMaintenanceSeat(latest, takeoverWindow(current), current.clock.now().getTime(), directories) !== lastSeen) {
            throw new Refused('NOT_YOURS', 'the gone-seat claim or checkout activity changed during maintenance');
          }
          return { args };
        };
        await ordered(ctx, board, 'release', args, { prepareInWriter });
      }),
    } : {}),
    /** Complete every linked archive fact before the runner may reset or remove source. */
    recordArchive: record => withBoard(ctx, async board => {
      for (const item of [...new Set(record.items)]) {
        await ordered(ctx, board, 'appendFact', [item, { agentId, kind: 'note',
          text: `Worktree work archived before maintenance cleanup: ${JSON.stringify(record.path)}; archive ${JSON.stringify(record.archive)}; retained HEAD ${record.head} at ${record.ref}; snapshot ${record.signature}.` }]);
      }
    }),
    /** Log each folder the sweep removed or kept as a board event naming its rule (#12537). */
    recordSweep: record => withBoard(ctx, async board => {
      logEvent(board, agentId, 'folder_swept', record.item ?? null, { action: record.action, rule: record.rule, path: record.path,
        ...(record.ref ? { ref: record.ref } : {}), ...(record.commit ? { commit: record.commit } : {}) });
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
