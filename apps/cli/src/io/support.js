/**
 * Helpers the command line uses to read its caller's input and read the board for a hook. None
 * keeps command state, so each is a plain function of its arguments [C9].
 */
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
import * as store from '../../../../packages/store/index.js';

const fs = fileSystemAdapter();

/** Read one consent line without waiting for EOF in an interactive terminal [V2]. */
export async function firstInputLine(stdin) {
  if (!stdin) return '';
  let text = '';
  for await (const chunk of stdin) {
    text += chunk.toString();
    const newline = text.indexOf('\n');
    if (newline >= 0) return text.slice(0, newline);
    if (text.length > 256) return '';
  }
  return text;
}

/** Wait up to the board's shared busy timeout while reading hook facts, without migrating its schema. */
export function hookRead(ctx, read) {
  if (!fs.exists(ctx.file)) return null;
  const startedAt = Date.now();
  let db;
  try {
    db = store.openBoardReadOnly(ctx.file);
    return read({ db, clock: ctx.clock, enginePorts: ctx.nativeBoard.nativeBoardPorts().enginePorts });
  } catch (error) {
    throw store.boardBusyError(ctx.file, startedAt, error);
  } finally { db?.close(); }
}
