/** The pullboard whoami command, in its own module so an item adding another command never edits these lines. */
import { boardId } from '../../../../../packages/store/light.js';
import { gitSyncLinked } from '../../../../../packages/store/light.js';
import { relayStateExists } from '../../../../../packages/store/light.js';
import { seatAddress } from '../../../../../packages/seats/light.js';
import { context } from '../read.js';
import { identifyCaller } from '../read.js';
import { withBoardRead } from '../board/read.js';

/** whoami reads the board through the light store; the full store loads only when the coordinator must be registered [C7]. */
export const nativeBoardRequired = false;

/** Run `pullboard whoami` and return its exit code. */
export async function run(io) {
  const ctx = context(io);
  // The relay client loads only where a relay token or link could name this seat.
  const relay = relayStateExists(ctx.info.commonDir) ? await import('../../../../../packages/link/index.js') : null;
  const linked = { environmentAgent: relay?.environmentAgent ?? (() => null), relayLinked: root => Boolean(relay?.relayLinked(root)) || gitSyncLinked(root) };
  const me = await withBoardRead(ctx, (board, readers) => {
    const agent = identifyCaller(ctx, board, linked, readers);
    return { ...agent, address: seatAddress(boardId(board), agent.id) };
  });
  io.result?.({ ...me, path: ctx.info.root });
  io.say(`${me.displayName} (${me.lane} lane${me.route === 'light' ? ', light route' : ''}) at ${ctx.info.root}\naddress ${me.address}`);
  return 0;
}
