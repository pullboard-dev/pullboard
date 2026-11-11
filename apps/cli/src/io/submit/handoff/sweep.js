/** One health sweep of a repository's queued and running gate hand-offs, run by the dispatcher on every drain [C7,#3221]. */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from '../../context.js';
import { sweepDeadSubmitHandoffs } from '../handoff.js';

/**
 * Open the repository's board as its main checkout and end every hand-off whose worker is gone.
 *
 * @param {string} commonDir - The repository's Git common directory, or its main checkout.
 * @param {{ nativeBoard: object }} ports - The native board openers.
 * @returns {Promise<number>} How many unfinished hand-offs the sweep looked at.
 */
export async function sweepRepository(commonDir, { nativeBoard }) {
  const root = basename(commonDir) === '.git' ? dirname(resolve(commonDir)) : resolve(commonDir);
  const ctx = context({ cwd: root, nativeBoard, say: () => {}, err: line => process.stderr.write(String(line) + '\n') });
  return sweepDeadSubmitHandoffs(ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  import('../../../../../lib/index.js')
    .then(nativeBoard => sweepRepository(process.argv[2], { nativeBoard }))
    .catch(error => { process.stderr.write(`[HANDOFF_SWEEP] ${error.message}\n`); process.exitCode = 1; });
}
