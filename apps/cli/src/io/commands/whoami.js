/** The pullboard whoami command, in its own module so an item adding another command never edits these lines. */
import { boardId } from '../../../../../packages/store/light.js';
import { gitSyncLinked } from '../../../../../packages/store/light.js';
import { relayStateExists } from '../../../../../packages/store/light.js';
import { seatAddress } from '../../../../../packages/seats/light.js';
import { readThinCommands } from '../../../../../packages/config/light.js';
import { thinWhoami } from '../whoami/thin.js';
import { context } from '../read.js';
import { identifyCaller } from '../read.js';
import { withBoardRead } from '../board/read.js';

/** whoami reads the board through the light store; the full store loads only when the coordinator must be registered [C7]. */
export const nativeBoardRequired = false;

/** Run `pullboard whoami` and return its exit code. */
export async function run(io) {
  const ctx = context(io);
  // With read.thinCommands on, the thin door serves a plain joined seat; null takes the full path [C7,#9811].
  const me = (readThinCommands() ? thinWhoami(ctx) : null) ?? await fullWhoami(ctx);
  const env = process.env.PULLBOARD_MODEL;
  const modelMismatch = env && me.model !== 'unknown' && env !== me.model ? { env, seat: me.model } : null;
  io.result?.({ ...me, path: ctx.info.root, ...(modelMismatch ? { modelMismatch } : {}) });
  io.say(`${me.displayName} (${me.lane} lane${me.role ? `, ${me.role}` : ''}${me.route === 'light' ? ', light route' : ''}) at ${ctx.info.root}\naddress ${me.address}`);
  if (modelMismatch) io.say(`PULLBOARD_MODEL=${env} differs from this seat's recorded model ${me.model}; verdicts use ${me.model}; make a seat for ${env} with pullboard worktree ${me.lane} --model ${env}`);
  return 0;
}

/** The full path: the caller's identity under every rule, including the relay and the coordinator seat. */
async function fullWhoami(ctx) {
  // The relay client loads only where a relay token or link could name this seat.
  const relay = relayStateExists(ctx.info.commonDir) ? await import('../../../../../packages/link/index.js') : null;
  const linked = { environmentAgent: relay?.environmentAgent ?? (() => null), relayLinked: root => Boolean(relay?.relayLinked(root)) || gitSyncLinked(root) };
  return withBoardRead(ctx, (board, readers) => {
    const agent = identifyCaller(ctx, board, linked, readers);
    return { ...agent, address: seatAddress(boardId(board), agent.id) };
  });
}
