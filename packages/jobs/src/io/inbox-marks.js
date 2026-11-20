/** Start the background worker that writes spooled inbox delivery marks, behind inbox.batchedMarks [C7,#8942]. */
import { spawnDetachedChild } from './launch.js';
import { environmentAdapter } from '../../../env/index.js';

/**
 * Start `node <worker> <boardFile>` detached and let the command exit at once.
 * Why: the inbox read must not wait on its own bookkeeping; the spool holds the marks, so a worker that never starts
 * loses nothing and the next one writes them.
 *
 * @param {string} worker - The script that opens the board and drains the spool.
 * @param {string} boardFile
 */
export function startMarksWorker(worker, boardFile) {
  const child = spawnDetachedChild(process.execPath, [worker, boardFile], { cwd: process.cwd(), env: environmentAdapter().all(), stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
