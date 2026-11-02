import { claimOverlapLines } from '../packages/activity/index.js';
import { claimOverlaps } from '../packages/items/index.js';
import { listItems, listAgents } from '../packages/store/index.js';
/** Authenticated machine-local activity only at explicit hooks or successful native writes [B3]. */
import { context } from './cli-read-context.js';
import {
  closeBoard,
  openBoardForRead,
} from '../packages/store/index.js';
import { heartbeatSeat } from '../packages/store/index.js';

const recorded = new WeakSet();

/** Observe only the registered local checkout after normal session binding; unknown callers gain no identity. */
export function heartbeatCommand(io, { ctx: suppliedContext, board: suppliedBoard } = {}) {
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
      for (const line of claimOverlapLines(listItems(board), listAgents(board), seat.agent_id, claimOverlaps)) io.err(line);
    }
  } catch (error) {
    if (!['NO_CONFIG', 'NOT_A_REPO'].includes(error.code)) io.err(`presence heartbeat unavailable: ${error.message}`);
  } finally { if (board && !suppliedBoard) closeBoard(board); }
}
