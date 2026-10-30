/**
 * Helpers the command line uses to read its caller's input and read the board for a hook. None
 * keeps command state, so each is a plain function of its arguments [C9].
 */
import { existsSync } from 'node:fs';
import * as store from './board.js';
import { nativeBoardPorts } from './native-board.js';

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

/**
 * Read everything git writes on a hook's stdin, or nothing when run by hand.
 *
 * @param {any} stdin
 * @returns {Promise<string>}
 */
export async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Wait up to the board's shared busy timeout while reading hook facts, without migrating its schema. */
export function hookRead(ctx, read) {
  if (!existsSync(ctx.file)) return null;
  const startedAt = Date.now();
  let db;
  try {
    db = store.openBoardReadOnly(ctx.file);
    return read({ db, clock: ctx.clock, enginePorts: nativeBoardPorts().enginePorts });
  } catch (error) {
    throw store.boardBusyError(ctx.file, startedAt, error);
  } finally { db?.close(); }
}
