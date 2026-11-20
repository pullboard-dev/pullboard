import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/**
 * Build the hook board reader from the store's read ports, which the hook command passes in.
 * Why: the reader waits up to the board's shared busy timeout without migrating its schema, and the thin hook entry
 * must not import the store by name [H24].
 *
 * @param {{ openBoardReadOnly: Function, boardBusyError: Function, readBoardSnapshot: Function }} ports
 * @returns {(ctx: any, read: (board: any) => any) => any}
 */
export function hookReader({ openBoardReadOnly, boardBusyError, readBoardSnapshot }) {
  return function hookRead(ctx, read) {
    if (!fs.exists(ctx.file)) return null;
    const startedAt = Date.now();
    let db;
    try {
      db = openBoardReadOnly(ctx.file);
      return read({ db, clock: ctx.clock, enginePorts: ctx.nativeBoard ? ctx.nativeBoard.nativeBoardPorts().enginePorts : readBoardSnapshot(db, ctx.clock).enginePorts });
    } catch (error) {
      throw boardBusyError(ctx.file, startedAt, error);
    } finally { db?.close(); }
  };
}
