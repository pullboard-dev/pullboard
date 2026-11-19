import { claimOverlapLines } from '../../../../packages/activity/index.js';
import { recordedClaimWorktrees } from '../../../../packages/activity/index.js';
import { claimOverlaps } from '../../../../packages/items/index.js';
import { listItems } from '../../../../packages/store/index.js';
import { listAgents } from '../../../../packages/store/index.js';
/** Authenticated machine-local activity only at explicit hooks or successful native writes [B3]. */
import { context } from './read.js';
import {
  closeBoard,
  openBoardForRead,
} from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { itemFolderIdentity } from './item/folder/identity.js';

const recorded = new WeakSet();
const KEEPALIVE_MS = 60_000;
let keepalive = null;

/**
 * Keep one seat's heartbeat fresh while this process runs, once per process.
 * A command like submit outlasts the two-minute seat-gone limit, so one heartbeat at its start is not enough (#2960).
 * The timer is unref'd so it never keeps the process alive, and each beat swallows every error.
 */
function keepSeatAlive(ctx, seatId, everyMs) {
  if (keepalive || !ctx.file) return;
  /** One beat: reopen the board for read, refresh the seat, close it; a missed beat is retried on the next tick. */
  const beat = () => {
    let board;
    try {
      board = openBoardForRead(ctx.file, ctx.clock);
      if (board) heartbeatSeat(board, seatId);
    } catch { /* retried on the next tick */ }
    finally { try { if (board) closeBoard(board); } catch { /* already closed */ } }
  };
  keepalive = { timer: setInterval(beat, everyMs), beat, everyMs };
  keepalive.timer.unref();
}

/** The running keepalive's interval and one-beat function, or null; tests drive beats through it. */
export function seatKeepalive() { return keepalive ? { everyMs: keepalive.everyMs, beat: keepalive.beat } : null; }

/** Stop this process's keepalive heartbeat; tests use it to start each case clean. */
export function stopSeatKeepalive() {
  if (keepalive) clearInterval(keepalive.timer);
  keepalive = null;
}

/**
 * Whether a requested move's heartbeat prints claim overlap lines: the default next omits them to honor its output bound, so it reads no item list [C7,#5329].
 * Both heartbeat callers use it; the first to run marks the io recorded, so a caller that disagreed would never apply.
 * @param {{ defaultLoop?: boolean }} io
 * @returns {boolean}
 */
export function claimHeartbeatOverlaps(io) { return io.defaultLoop !== true; }

/**
 * Observe only the registered local checkout, or its seat's live item folder, after normal session binding;
 * unknown callers gain no identity. A successful beat keeps the seat fresh for the rest of the process; default next omits overlap text to honor its output bound.
 */
export function heartbeatCommand(io, { ctx: suppliedContext, board: suppliedBoard, keepaliveMs = KEEPALIVE_MS, overlaps = true } = {}) {
  if (recorded.has(io)) return;
  let board;
  try {
    const ctx = suppliedContext ?? context(io);
    board = suppliedBoard ?? openBoardForRead(ctx.file, ctx.clock);
    if (!board) return;
    // Only the registered id is needed: projecting model/presence would reopen this same sidecar.
    // A seat's item folder acts as that seat, the same as its checkout (#2960).
    const seat = board.db.prepare('SELECT agent_id FROM agent WHERE agent_path=?').get(ctx.info.root)
      ?? itemFolderIdentity(board, ctx.info.root)?.agent;
    if (seat && heartbeatSeat(board, seat.agent_id)) {
      recorded.add(io);
      keepSeatAlive(ctx, seat.agent_id, keepaliveMs);
      // Overlap reads the recorded worktree files; it never runs Git in another seat's worktree (#2427).
      // The lists are read only when their overlap lines print; a heartbeat with overlaps off sends no item query.
      if (overlaps) {
        const items = listItems(board), agents = listAgents(board);
        for (const line of claimOverlapLines(items, agents, seat.agent_id, claimOverlaps, recordedClaimWorktrees(items, agents, board))) io.err(line);
      }
    }
  } catch (error) {
    if (!['NO_CONFIG', 'NOT_A_REPO'].includes(error.code)) io.err(`presence heartbeat unavailable: ${error.message}`);
  } finally { if (board && !suppliedBoard) closeBoard(board); }
}
