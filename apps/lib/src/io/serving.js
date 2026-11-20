/** Whether a queued gate launch still serves its item, read from its captured request and the board [C7]. */
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
import { handoffServes } from '../../../../packages/store/index.js';

const fs = fileSystemAdapter();

/**
 * Whether a waiting launch's hand-off still serves its item; false when its captured request is unreadable.
 * Why: the dispatcher must never admit the gate of a withdrawn, reopened or replaced item (#4072, SM1).
 *
 * @param {any} board - The launch's board, open.
 * @param {{ directory: string, job: string }} launch - A queued launch ticket.
 * @returns {boolean}
 */
export function launchServes(board, launch) {
  let request;
  try { request = JSON.parse(fs.readFile(join(launch.directory, 'request.json'), 'utf8')); } catch { return false; }
  return Number.isSafeInteger(request.item) && handoffServes(board, request.item, launch.job);
}
