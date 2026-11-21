/** The mark spool: a mark the board refused as busy or unreachable waits in one local file and is replayed, in order and with its original time, by the next mark that writes [C7,#12158]. */
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
import { events } from '../../../../packages/store/index.js';

const fs = fileSystemAdapter();
/** The spool's file name, inside the folder that holds the board file. */
export const SPOOL_FILE = 'mark-spool.jsonl';
/** The refusals that mean the board cannot take a write now; any other refusal still fails the command. */
const SPOOLED_CODES = new Set(['BOARD_BUSY', 'BOARD_UNREACHABLE']);

/**
 * Whether a refusal is one the spool absorbs.
 * @param {any} error
 * @returns {boolean}
 */
export function spoolable(error) {
  return SPOOLED_CODES.has(error?.code);
}

/**
 * The spool file for a board file.
 * @param {string} boardFile The board's own file.
 * @returns {string}
 */
export function spoolPath(boardFile) {
  return join(dirname(boardFile), SPOOL_FILE);
}

/**
 * Append one mark to the spool as one JSON line; the line keeps the mark's own id and original at.
 * @param {string} boardFile
 * @param {{ id: string, item: number, agentId: string, stage: string, edge: string, reason: string|null, ref: string|null, at: number }} line
 * @returns {void}
 */
export function spoolMark(boardFile, line) {
  fs.appendFile(spoolPath(boardFile), `${JSON.stringify(line)}\n`);
}

/** The spooled lines in order; a line that is not a mark is dropped. */
function spooledLines(file) {
  if (!fs.exists(file)) return [];
  const lines = [];
  for (const text of fs.readFile(file).split('\n')) {
    if (!text.trim()) continue;
    try {
      const line = JSON.parse(text);
      if (line && typeof line.id === 'string' && Number.isInteger(line.item) && typeof line.agentId === 'string') lines.push(line);
    } catch { /* a torn last line from a crash carries no mark */ }
  }
  return lines;
}

/** Whether the item's mark rows already carry this id, read by the item's own event index. */
function carries(board, line) {
  return events(board, { itemId: line.item, kinds: ['mark'] }).some(event => {
    try { return JSON.parse(event.event_detail ?? '{}').id === line.id; } catch { return false; }
  });
}

/**
 * Replay the spool in order, each mark with its original at, then empty it.
 * Why: a line whose id the item already carries is skipped, so a replay that died halfway never doubles a row; a line for an item that no longer exists is dropped.
 *
 * @param {string} boardFile
 * @param {any} board An open board, read only to look up the ids a mark row already carries.
 * @param {(line: object) => Promise<void>} write Writes one mark through the board's ordered write; it may throw a busy refusal, which leaves the spool as it is.
 * @returns {Promise<number>} How many marks this replay wrote.
 */
export async function replaySpool(boardFile, board, write) {
  const file = spoolPath(boardFile);
  const lines = spooledLines(file);
  if (lines.length === 0) return 0;
  let written = 0;
  for (const line of lines) {
    if (carries(board, line)) continue;
    try {
      await write(line);
      written++;
    } catch (error) {
      if (error?.code !== 'NO_ITEM') throw error;
    }
  }
  fs.writeFile(file, '');
  return written;
}

/** The real mark write: one appendMark through the board's ordered writer. */
async function orderedMark(ctx, board, { item, id, agentId, stage, edge, reason, ref, at }) {
  const { ordered } = await import('./claim.js');
  await ordered(ctx, board, 'appendMark', [item, { id, agentId, stage, edge, reason, ref, at }]);
}

/**
 * Record one mark for a command that is not `pullboard mark`: one append, no scan, and a failed write spools the mark instead of failing the caller.
 * Why: the claim and test paths write marks on the board's own account, so a busy board must never fail them (#12158 spool).
 *
 * @param {any} io The command's io; `io.markWriter` replaces the real write when a caller injects one.
 * @param {any} ctx
 * @param {any} board An open board.
 * @param {{ item: number, agentId: string, stage: string, edge: string, reason?: string|null, ref?: string|null, at: number }} mark
 * @returns {Promise<boolean>} true when the board took the mark, false when it was spooled.
 */
export async function recordMark(io, ctx, board, { item, agentId, stage, edge, reason = null, ref = null, at }) {
  const line = { id: randomUUID(), item, agentId, stage, edge, reason, ref, at };
  try {
    await (io.markWriter ?? orderedMark)(ctx, board, line);
    return true;
  } catch {
    spoolMark(ctx.file, line);
    return false;
  }
}
