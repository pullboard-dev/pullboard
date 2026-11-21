/** Compose maintenance with native board readers and ordinary archive facts [B3,C7]. */
import { agentHandoff } from '../../../../../../packages/state/index.js';
import { lineSettings } from '../../../../../../packages/state/index.js';
import { SEAT_LIVE_WINDOW_MS } from '../../../../../../packages/store/index.js';
import { mainPolicy } from '../../../../../../packages/sandbox/index.js';
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
export function readMaintenanceSnapshot(ctx) {
  return withBoardRead(ctx, board => ({
    seats: withLocalSeatPresence(board, listAgents(board)).map(seat => ({ ...seat, createdAt: seat.agent_created_at,
      completedTakeoverAt: agentHandoff(board, seat.agent_id)?.takenAt ?? null })),
    items: listItems(board, { all: true }),
    // The line's takeover window, the same one claims use; a seat idle past it with no claim may be retired (#8199).
    takeoverMs: typeof lineSettings(board).takeoverMinutes === 'number' ? lineSettings(board).takeoverMinutes * 60_000 : SEAT_LIVE_WINDOW_MS,
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

/** Keep diagnostic detail useful without echoing credential-like values or structured payloads. */
function cleanupFailure(error) {
  const code = String(error?.code ?? error?.name ?? 'Error').replace(/[\r\n\t]/gu, ' ').slice(0, 80);
  let detail = String(error?.message ?? '').replace(/[\r\n\t]/gu, ' ').trim();
  if (/^[{[]/u.test(detail)) detail = '[structured details omitted]';
  detail = detail.replace(/\b(Bearer\s+)\S+/giu, '$1[redacted]')
    .replace(/\b(password|passwd|token|secret|authorization|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, '$1[redacted]@')
    .slice(0, 240);
  return `maintenance kept the worktree; cleanup failed: ${code}${detail ? `: ${detail}` : ''}`;
}

/** Optional housekeeping cannot turn an already-recorded lifecycle move into a false command failure. */
export async function cleanupMaintenanceLifecycle(ctx, agentId, details, { clean = cleanMaintenanceSeat } = {}) {
  if (ctx.config.worktreeMaintenance?.enabled !== true) return null;
  try {
    const accepted = mainPolicy(ctx.info.root).config;
    const result = await clean(ctx.info.root, accepted,
      { ...maintenanceCommandPorts(ctx, agentId), completedTakeover: details.completedTakeover === true,
        completedWithdrawal: details.completedWithdrawal === true && ctx.info.isMain && agentId === 'coordinator' }, details);
    if ((details.withdrawn || result?.clean) && accepted.worktreeMaintenance?.enabled === true) {
      await recordMaintenanceRetention(ctx.info.root, { ...details,
        reason: 'withdrawal cleanup deferred: checkout is protected, busy or still holds another obligation' }, { clear: Boolean(result?.clean) });
    }
    if (!result) ctx.io.err('maintenance kept the worktree because it is protected, busy or still holds another obligation');
    return result;
  } catch (error) {
    ctx.io.err(cleanupFailure(error));
    return null;
  }
}
