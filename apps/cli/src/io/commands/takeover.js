/** The pullboard takeover command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  context,
  ordered,
  whoAmI,
  withBoard,
} from '../entry.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { laneNames } from '../../../../../packages/seats/index.js';
import { relayLinked } from '../../../../../packages/link/index.js';
import { relayMachineContext } from '../../../../../packages/link/index.js';
import { relayOperation } from '../../../../../packages/link/index.js';

/** The takeCoordinator a session already sent while taking this checkout over, by command invocation. */
const TAKEN = new WeakMap();

/** The coordinator move's arguments: this checkout's relay machine id names it in the hold. */
function takeArgs(root) {
  const state = relayMachineContext(root);
  const machine = state?.machine;
  return [{ agentId: COORDINATOR, ...(typeof machine === 'string' ? { machine } : {}), ...(state?.computerName === undefined ? {} : { name: state.computerName }) }];
}

/**
 * Record that a new agent session took this checkout over. In a linked main checkout the board's coordinator is
 * taken first, as an ordered move, so the receipt shout that follows is the holder's own and the hold the session
 * is taking never refuses it; a takeover never stops at the step the refusal tells it to run (#347).
 *
 * @param {any} io
 * @param {{ root: string, isMain: boolean }} info
 */
export async function recordCheckoutTakeover(io, info) {
  const ctx = context(io);
  await withBoard(ctx, async (board) => {
    const me = whoAmI(ctx, board);
    const linked = relayLinked(info.root);
    if (info.isMain && linked) {
      const args = takeArgs(info.root);
      TAKEN.set(io, await relayOperation(info.root, 'takeCoordinator', args, io, undefined, () => store.takeCoordinator(board, ...args)));
    }
    const message = { from: me.id, to: info.isMain ? 'person' : COORDINATOR,
      text: `${me.displayName} took over this checkout in a new agent session.`, lanes: laneNames(ctx.config) };
    if (linked) await relayOperation(info.root, 'shout', [message], io, undefined, () => store.shout(board, message));
    else store.shout(board, message);
  });
}

/**
 * Run `pullboard takeover` and return its exit code. In an agent worktree it rebinds the checkout to this agent
 * session. In the main checkout of a linked board it also takes the board's coordinator for this checkout, as an
 * ordered move, so another machine's or person's main checkout stops acting as coordinator (#347).
 */
export async function run(io) {
  const ctx = context(io);
  const me = withBoard(ctx, (board) => whoAmI(ctx, board));
  if (ctx.info.isMain && relayLinked(ctx.info.root)) {
    const taken = TAKEN.get(io) ?? await withBoard(ctx, (board) => ordered(ctx, board, 'takeCoordinator', takeArgs(ctx.info.root)));
    io.result?.({ agent: me.id, path: ctx.info.root, coordinator: taken.holder, previous: taken.previous });
    io.say(`${me.displayName} now coordinates this board from ${taken.holder}${taken.previous && taken.previous !== taken.holder ? `, taking over from ${taken.previous}` : ''}`);
    return 0;
  }
  io.result?.({ agent: me.id, path: ctx.info.root });
  io.say(`${me.displayName} took over this checkout for the current agent session`);
  return 0;
}
