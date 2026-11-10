/** Explicit opt-in to account-free sharing through the repository's own Git remote [H11]. */
import {
  context,
  withBoard,
} from '../context.js';
import {
  relayLinked,
  relayRecovered,
} from '../../../../../packages/link/index.js';
import { syncGitBoard } from '../../../../../packages/sync/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Publish or receive the board's acknowledged Git prefix without signing into a relay account. */
export async function run(io, { first }) {
  if (first) throw new Refused('USAGE', 'pullboard sync takes no arguments; it shares through origin');
  const ctx = context(io);
  if (relayLinked(ctx.info.root) || relayRecovered(ctx.info.root, {}, io)) throw new Refused('GIT_SYNC_LINKED', 'this board already uses the relay; it cannot use a second move order', 'keep syncing this board through its relay');
  const result = await withBoard(ctx, board => syncGitBoard(ctx.info.root, board, io, { settlePending: true }));
  io.result?.(result);
  io.say(`board shared through origin at move ${result.sequence}`);
  return 0;
}
