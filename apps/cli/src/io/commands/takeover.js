/** The pullboard takeover command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  context,
  optionalModel,
  ordered,
  whoAmI,
  withBoard,
} from '../entry.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { displayAgentName } from '../../../../../packages/seats/index.js';
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
 * Record the model of the session taking the main checkout over, so answers and shouts name the model that holds
 * the seat and not the previous holder's. Why: a takeover rebinds the session but kept the old declaration. A coordinator
 * on another checkout keeps its own declaration, and a session that declares no model changes nothing.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ root: string }} info
 */
function sessionModel(board, info) {
  const model = optionalModel(undefined);
  const coordinator = store.listAgents(board).find((agent) => agent.agent_id === COORDINATOR);
  if (model === undefined || !coordinator || coordinator.agent_path !== info.root || coordinator.agent_model === model) return undefined;
  return model;
}

/** Declare that model on the board once the takeover holds the checkout; the declaration is an ordered move like join's. */
async function declareSessionModel(ctx, board, info) {
  const model = sessionModel(board, info);
  if (model === undefined) return;
  const coordinator = store.listAgents(board).find((agent) => agent.agent_id === COORDINATOR);
  await ordered(ctx, board, 'register', [{ lane: COORDINATOR, path: info.root, route: coordinator.agent_route ?? 'strong', model }]);
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
    const linked = relayLinked(info.root);
    if (info.isMain && linked) {
      const args = takeArgs(info.root);
      TAKEN.set(io, await relayOperation(info.root, 'takeCoordinator', args, io, undefined, () => store.takeCoordinator(board, ...args)));
    }
    const me = whoAmI(ctx, board);
    const model = info.isMain ? sessionModel(board, info) : undefined;
    const name = model === undefined ? me.displayName : displayAgentName({ agent_id: me.id, agent_model: model }, ctx.config.agents.names);
    const message = { from: me.id, to: info.isMain ? 'person' : COORDINATOR,
      text: `${name} took over this checkout in a new agent session.`, lanes: laneNames(ctx.config) };
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
  if (ctx.info.isMain) await withBoard(ctx, (board) => declareSessionModel(ctx, board, ctx.info));
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
