/** The board's production pull adapter: always built over a file store in the board's own folder [C7]. */
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { pullAdapter } from '../pull.js';
import { revokedRunnerNames } from './keys.js';
import { trustedRunnerKeys } from './keys.js';
import { fileStore } from './store.js';
import { PULL_STORE_FILE } from './store.js';

export { PULL_STORE_FILE };

/**
 * Build the pull adapter the board serves runners with, over a store kept in the board's folder.
 *
 * Why: an adapter built without a store forgets its offers and its spent take nonces at every restart, which reopens
 * the replay window; the board's own builder never leaves the store out, so a caller cannot forget it.
 *
 * @param {{ folder: string } & Omit<Parameters<typeof pullAdapter>[0], 'store' | 'trusted'> & { trusted?: Parameters<typeof pullAdapter>[0]['trusted'] }} options - The adapter's ports, and the board folder; the trusted keys default to the board's runner key book.
 * @returns {ReturnType<typeof pullAdapter>}
 */
export function boardPullAdapter({ folder, ...ports }) {
  fileSystemAdapter().mkdir(folder, { recursive: true, mode: 0o700 });
  return pullAdapter({ trusted: () => trustedRunnerKeys(folder), revokedNames: () => revokedRunnerNames(folder), ...ports, store: fileStore(join(folder, PULL_STORE_FILE)) });
}
