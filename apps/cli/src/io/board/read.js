/** The CLI's async boundary: ordinary reads load queries, genuine write fallbacks load the full store [C7]. */
import * as store from '../../../../../packages/store/light.js';
import { withOpenedBoard } from '../read.js';
import { Refused } from '../../../../../packages/kernel/light.js';

/** Keep the old full-store fallback and pass its synchronous backend to the same work callback. */
export async function writeFallback(ctx, work) {
  await ctx.io.prepareProcessPorts?.();
  ctx.nativeBoard = ctx.io.nativeBoard ??= await ctx.io.loadNativeBoard();
  const full = await import('../../../../../packages/store/index.js');
  const { withBoard } = await import('../context.js');
  return withBoard(ctx, board => work(board, { ...full, ensureCoordinator: full.board_ensureCoordinator }));
}

/** Open exactly as the synchronous read API does; only the CLI awaits a needed full-store import. */
export async function withBoardRead(ctx, work) {
  const board = store.openBoardForRead(ctx.file, ctx.clock);
  // Main repairs a drifted board on a write open, so a read there takes that path once (#5825).
  const write = board && !board.current && (!ctx.allowSchemaUpgrade || board.drifted);
  if (write) store.closeBoard(board);
  if (!board || write) return writeFallback(ctx, work);
  try { return await withOpenedBoard(ctx, opened => work(opened, store), board); }
  catch (error) {
    const needsWrite = error instanceof store.ReadNeedsWrite || store.writeRefused(error);
    if (board.current && needsWrite) return writeFallback(ctx, work);
    if (!needsWrite && !store.schemaMissing(error)) throw error;
    throw new Refused('BOARD_SCHEMA_BEHIND', 'this board was made by an older pullboard and a read never upgrades it');
  }
}
