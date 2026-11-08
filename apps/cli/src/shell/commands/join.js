import {
  parentIdentity,
  parentSessionDigest,
  runtimeSessionIdentity,
} from '../../../../../packages/items/index.js';
/** The pullboard join command, in its own module so an item adding another command never edits these lines. */
import {
  displayAgentName,
} from '../../../../../packages/seats/index.js';
import { seatWakeCommand } from '../../../../../packages/seats/index.js';
import { registerSeatWake } from '../../../../../packages/seats/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  isLane,
  laneNames,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  relayLinked,
} from '../../../../../packages/link/index.js';
import * as store from '../../../../../packages/store/index.js';
import { itemFolderSeat } from '../item-folder-identity.js';
import { seatFamily } from '../../../../../packages/items/index.js';
import { projectBoardIdentity } from '../../../../../packages/seats/index.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { modelTierRoute } from '../model-tier-route.js';
import {
  context,
  ordered,
  refuseRemoteCoordinatorModel,
  requiredModel,
  shellWord,
  withBoard,
  withBoardRead,
  primaryCheckoutRoot,
} from '../cli.js';

/** Run `pullboard join` and return its exit code. */
/**
 * Whether a model is a small, light-route model: a claude-haiku-* model or gpt-6-luna.
 * A seat on such a model joins the light route unless it names --route, so it never claims strong work.
 */
export function lightModel(model) {
  return /^claude-haiku-/u.test(String(model ?? '')) || model === 'gpt-6-luna';
}
export async function run(io, { first, values }) {
  const ctx = context(io);
  const folder = itemFolderSeat(ctx.info.root);
  if (folder) {
    const from = folder.seat ? JSON.stringify(folder.seat) : 'the lane worktree this folder was made from';
    throw new Refused('JOIN_IN_ITEM_FOLDER', `${ctx.info.root} is an item folder, not a lane worktree; a seat joined here is lost with the folder and its work. Run pullboard from ${from} instead, and join only from a lane worktree made with git worktree add ../<repo>-<lane>`);
  }
  const wake = seatWakeCommand(values.wake, ctx.info.root);
  const runtime = runtimeSessionIdentity();
  const parent = values.parent === undefined ? runtime?.parent : parentIdentity(values.parent);
  const parentDigest = parent ? parentSessionDigest(parent) : undefined;
  const sessionDigest = runtime?.session ? parentSessionDigest(runtime.session) : undefined;
  if (ctx.info.isMain) {
    if (first !== COORDINATOR) throw new Refused('MAIN_IS_COORDINATOR', 'the main checkout is the coordinator; join from a worktree: git worktree add ../<dir>');
    const model = requiredModel(values.model, process.env, `join ${shellWord(COORDINATOR)}${values.route ? ` --route ${shellWord(values.route)}` : ''}${values.family ? ` --family ${shellWord(values.family)}` : ''}`);
    const route = values.route ?? 'strong'; // The coordinator is always strong, whatever tier its model name maps to.
    if (relayLinked(ctx.info.root)) refuseRemoteCoordinatorModel(ctx, 'join coordinator');
    const joined = await withBoard(ctx, async (board) => {
      const id = await ordered(ctx, board, 'register', [
        { lane: COORDINATOR, path: ctx.info.root, route, family: values.family, model, parentDigest, sessionDigest },
      ]);
      return { id, boardId: store.boardId(board), family: seatFamily(board, id) };
    });
    registerProject(ctx.info.root, new Date(), ctx.config, projectBoardIdentity(ctx.info.root, joined.boardId));
    const id = joined.id;
    registerSeatWake(ctx.info, joined.boardId, id, wake);
    const displayName = displayAgentName({ agent_id: id, agent_model: model }, ctx.config.agents.names);
    io.result?.({ agent: id, lane: COORDINATOR, route, path: ctx.info.root, model, displayName, family: joined.family ?? null });
    io.say(`declared ${displayName}${joined.family ? ` (family ${joined.family})` : ''} in the coordinator lane`);
    return 0;
  }
  if (!first || first === COORDINATOR || !isLane(ctx.config, first)) {
    throw new Refused('NO_LANE', `no lane "${first ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
  }
  const model = requiredModel(values.model, process.env, `join ${shellWord(first)}${values.route ? ` --route ${shellWord(values.route)}` : ''}${values.family ? ` --family ${shellWord(values.family)}` : ''}`);
  const existing = withBoardRead(ctx, board => store.agentAt(board, ctx.info.root));
  const sameSeat = existing?.agent_lane === first && existing.agent_model === model;
  const route = values.route ?? existing?.agent_route ?? process.env.PULLBOARD_ROUTE ?? modelTierRoute(model, ctx.config.modelTiers);
  // Explicit registration updates must reach the board even when the seat identity is unchanged.
  if (sameSeat && values.family === undefined && values.route === undefined && values.wake === undefined) {
    const displayName = displayAgentName(existing, ctx.config.agents.names);
    io.result?.({ agent: existing.agent_id, lane: first, route: existing.agent_route, path: ctx.info.root,
      model: existing.agent_model, displayName, family: existing.agent_family ?? null, alreadyJoined: true });
    io.say(`already joined as ${displayName}${existing.agent_family ? ` (family ${existing.agent_family})` : ''}; run pullboard next`);
    return 0;
  }
  if (existing && !sameSeat) {
    throw new Refused('ALREADY_JOINED',
      `this worktree is already joined as ${existing.agent_id}; retry with lane ${existing.agent_lane} and model ${JSON.stringify(existing.agent_model)}`);
  }
  const projectRoot = primaryCheckoutRoot(ctx.info);
  if (!projectRoot) throw new Refused('NO_POLICY', 'cannot safely register the project without locating its main checkout; restore Git worktree metadata and retry join');
  // Read the family from the same board connection as registration, avoiding a costly reopen on large boards.
  const joined = await withBoard(ctx, async (board) => {
    const id = await ordered(ctx, board, 'register', [{ lane: first, path: ctx.info.root, route, family: values.family, model, parentDigest, sessionDigest }]);
    return { id, boardId: store.boardId(board), family: seatFamily(board, id) };
  });
  registerProject(projectRoot, new Date(), ctx.config, projectBoardIdentity(projectRoot, joined.boardId));
  const id = joined.id;
  registerSeatWake(ctx.info, joined.boardId, id, wake);
  const displayName = displayAgentName({ agent_id: id, agent_model: model }, ctx.config.agents.names);
  io.result?.({ agent: id, lane: first, route, path: ctx.info.root, model, displayName, family: joined.family ?? null, ...(sameSeat ? { alreadyJoined: true } : {}) });
  io.say(sameSeat
    ? `already joined as ${displayName}${joined.family ? ` (family ${joined.family})` : ''}; run pullboard next`
    : `joined as ${displayName}${joined.family ? ` (family ${joined.family})` : ''} in the ${first} lane${route === 'light' ? ', on the light route' : ''}`);
  return 0;
}
