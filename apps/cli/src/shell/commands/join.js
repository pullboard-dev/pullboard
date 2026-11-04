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
import { seatFamily } from '../../../../../packages/items/index.js';
import { projectBoardIdentity } from '../../../../../packages/seats/index.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import {
  context,
  ordered,
  refuseRemoteCoordinatorModel,
  requiredModel,
  shellWord,
  withBoard,
  primaryCheckoutRoot,
} from '../cli.js';

/** Run `pullboard join` and return its exit code. */
export async function run(io, { first, values }) {
  const ctx = context(io);
  const wake = seatWakeCommand(values.wake, ctx.info.root);
  const runtime = runtimeSessionIdentity();
  const parent = values.parent === undefined ? runtime?.parent : parentIdentity(values.parent);
  const parentDigest = parent ? parentSessionDigest(parent) : undefined;
  const sessionDigest = runtime?.session ? parentSessionDigest(runtime.session) : undefined;
  if (ctx.info.isMain) {
    if (first !== COORDINATOR) throw new Refused('MAIN_IS_COORDINATOR', 'the main checkout is the coordinator; join from a worktree: git worktree add ../<dir>');
    const route = values.route ?? 'strong';
    const model = requiredModel(values.model, process.env, `join ${shellWord(COORDINATOR)}${values.route ? ` --route ${shellWord(values.route)}` : ''}${values.family ? ` --family ${shellWord(values.family)}` : ''}`);
    if (relayLinked(ctx.info.root)) refuseRemoteCoordinatorModel(ctx, 'join coordinator');
    const joined = await withBoard(ctx, async (board) => ({
      id: await ordered(ctx, board, 'register', [
        { lane: COORDINATOR, path: ctx.info.root, route, family: values.family, model, parentDigest, sessionDigest },
      ]),
      boardId: store.boardId(board),
    }));
    joined.family = await withBoard(ctx, async (board) => seatFamily(board, joined.id));
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
  const route = values.route ?? process.env.PULLBOARD_ROUTE ?? 'strong';
  const model = requiredModel(values.model, process.env, `join ${shellWord(first)}${values.route ? ` --route ${shellWord(values.route)}` : ''}${values.family ? ` --family ${shellWord(values.family)}` : ''}`);
  const projectRoot = primaryCheckoutRoot(ctx.info);
  if (!projectRoot) throw new Refused('NO_POLICY', 'cannot safely register the project without locating its main checkout; restore Git worktree metadata and retry join');
  const joined = await withBoard(ctx, async (board) => ({
    id: await ordered(ctx, board, 'register', [{ lane: first, path: ctx.info.root, route, family: values.family, model, parentDigest, sessionDigest }]),
    boardId: store.boardId(board),
  }));
  // The family the board now holds for this seat, so a join always confirms what was recorded (#2889).
  joined.family = await withBoard(ctx, async (board) => seatFamily(board, joined.id));
  registerProject(projectRoot, new Date(), ctx.config, projectBoardIdentity(projectRoot, joined.boardId));
  const id = joined.id;
  registerSeatWake(ctx.info, joined.boardId, id, wake);
  const displayName = displayAgentName({ agent_id: id, agent_model: model }, ctx.config.agents.names);
  io.result?.({ agent: id, lane: first, route, path: ctx.info.root, model, displayName, family: joined.family ?? null });
  io.say(`joined as ${displayName}${joined.family ? ` (family ${joined.family})` : ''} in the ${first} lane${route === 'light' ? ', on the light route' : ''}`);
  return 0;
}
