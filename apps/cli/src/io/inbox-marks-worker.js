/** The background worker for inbox.batchedMarks: writes the spooled delivery marks in one batch [C7,#8942]. */
import { fileURLToPath } from 'node:url';
import * as store from '../../../../packages/store/index.js';

/** The script the inbox command launches. */
export const MARKS_WORKER = fileURLToPath(import.meta.url);

/** Open the board, write every spooled mark in one transaction, close it; returns how many agents' marks were written. */
export async function runMarksWorker(boardFile) {
  const { openBoard } = await import('../../../lib/index.js');
  const board = openBoard(boardFile);
  try {
    return store.drainInboxMarks(boardFile, { enqueue: (agent, mark) => store.enqueueInboxMark(board, agent, mark), flush: () => store.flushInboxMarks(board) });
  } finally { store.closeBoard(board); }
}

if (process.argv[1] === MARKS_WORKER) runMarksWorker(process.argv[2]).catch(() => { process.exitCode = 1; });
