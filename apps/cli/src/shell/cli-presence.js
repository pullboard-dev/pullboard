import { claimOverlapLines } from '../../../../packages/activity/index.js';
import { recordedClaimWorktrees } from '../../../../packages/activity/index.js';
import { claimOverlaps } from '../../../../packages/items/index.js';
import { listItems } from '../../../../packages/store/index.js';
import { listAgents } from '../../../../packages/store/index.js';
/** Authenticated machine-local activity only at explicit hooks or successful native writes [B3]. */
import { context } from './cli-read-context.js';
import {
  closeBoard,
  openBoardForRead,
} from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';

const recorded = new WeakSet();

/** Observe only the registered local checkout after normal session binding; unknown callers gain no identity. The default next loop omits overlap text to honor its output bound. */
export function heartbeatCommand(io, { ctx: suppliedContext, board: suppliedBoard, overlaps = true } = {}) {
  if (recorded.has(io)) return;
  let board;
  try {
    const ctx = suppliedContext ?? context(io);
    board = suppliedBoard ?? openBoardForRead(ctx.file, ctx.clock);
    if (!board) return;
    // Only the registered id is needed: projecting model/presence would reopen this same sidecar.
    const seat = board.db.prepare('SELECT agent_id FROM agent WHERE agent_path=?').get(ctx.info.root);
    if (seat && heartbeatSeat(board, seat.agent_id)) {
      recorded.add(io);
      // Overlap reads the recorded worktree files; it never runs Git in another seat's worktree (#2427).
      const items = listItems(board), agents = listAgents(board);
      if (overlaps) for (const line of claimOverlapLines(items, agents, seat.agent_id, claimOverlaps, recordedClaimWorktrees(items, agents, board))) io.err(line);
    }
  } catch (error) {
    if (!['NO_CONFIG', 'NOT_A_REPO'].includes(error.code)) io.err(`presence heartbeat unavailable: ${error.message}`);
  } finally { if (board && !suppliedBoard) closeBoard(board); }
}
