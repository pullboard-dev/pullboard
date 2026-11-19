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
  COORDINATOR_GUIDE_FILE,
  reviewCanonicalFamilies,
  joinCoordinatorSeat,
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
import { gitExecFileSync } from '../../../../../packages/git/light.js';
import { itemFolderSeat } from '../item/folder/identity.js';
import { canonicalVendorFamily } from '../../../../../packages/items/index.js';
import { seatFamily } from '../../../../../packages/items/index.js';
import { projectBoardIdentity } from '../../../../../packages/seats/index.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { modelTierRoute } from '../route.js';
import {
  context,
  ordered,
  refuseRemoteCoordinatorModel,
  requiredModel,
  shellWord,
  withBoard,
  withBoardRead,
  primaryCheckoutRoot,
} from '../entry.js';

/**
 * The family label a joining seat registers: canonical under review.canonicalFamilies, as typed otherwise. Read here in the
 * command layer, never inside a move, so a replayed register stays what it recorded (#9681).
 */
function registeredFamily(label) {
  return reviewCanonicalFamilies() ? canonicalVendorFamily(label) : label;
}

/**
 * Join a lane on the board host board.url names [P7]. The served board registers the seat with a remote marker in
 * place of a path here, and this worktree's git config keeps its name (pullboard.agent) and its own key
 * (pullboard.seatKey), which every later move as this seat carries [#10790].
 * @param {any} io
 * @param {{ positionals: string[], values: any }} parsed
 * @param {string} origin The board host, as the seat prints it.
 * @param {(move: object) => Promise<any>} postMove Posts one move to the served board.
 */
export async function joinRemote(io, { positionals, values }, origin, postMove) {
  const lane = positionals[1];
  if (!lane) throw new Refused('NO_LANE', 'name a lane: pullboard join <lane> --model "<model name>" (see: pullboard lanes)');
  const model = requiredModel(values.model, environmentAdapter().all(), `join ${shellWord(lane)}`);
  const ctx = context(io);
  const route = values.route ?? environmentAdapter().get('PULLBOARD_ROUTE') ?? modelTierRoute(model, ctx.config.modelTiers);
  const { result } = await postMove({ verb: 'join', args: { lane, model, route, ...(values.family === undefined ? {} : { family: registeredFamily(values.family) }) } });
  // Per-worktree config, so each seat's worktree in one clone keeps its own name.
  gitExecFileSync(['config', 'extensions.worktreeConfig', 'true'], { cwd: ctx.info.root, stdio: 'ignore' });
  gitExecFileSync(['config', '--worktree', 'pullboard.agent', result.agent], { cwd: ctx.info.root, stdio: 'ignore' });
  // A board host from before seat keys issues none: the old key is removed so it is never sent as the new seat's.
  if (result.key) gitExecFileSync(['config', '--worktree', 'pullboard.seatKey', result.key], { cwd: ctx.info.root, stdio: 'ignore' });
  else try { gitExecFileSync(['config', '--worktree', '--unset', 'pullboard.seatKey'], { cwd: ctx.info.root, stdio: 'ignore' }); } catch { /* none was kept */ }
  io.result?.({ agent: result.agent, lane, route, model, board: origin });
  io.say(`joined as ${result.agent} in the ${lane} lane via ${origin}${route === 'light' ? ', on the light route' : ''}`);
}

/** Run `pullboard join` and return its exit code. */
export async function run(io, { first: named, values }) {
  const ctx = context(io);
  // laneMode off: a seat names no lane; it is labelled with the first declared one and next serves every lane [C7,#8906].
  const first = named ?? (ctx.config.laneMode === 'off' && !ctx.info.isMain ? laneNames(ctx.config).filter(lane => lane !== COORDINATOR)[0] : undefined);
  const folder = itemFolderSeat(ctx.info.root);
  if (folder) {
    const from = folder.seat ? JSON.stringify(folder.seat) : 'the lane worktree this folder was made from';
    throw new Refused('JOIN_IN_ITEM_FOLDER', `${ctx.info.root} is an item folder, not a lane worktree; a seat joined here is lost with the folder and its work. Run pullboard from ${from} instead, and join only from a lane worktree made with git worktree add ../<repo>-<lane>`);
  }
  if (values.role !== undefined && values.role !== 'advisor') throw new Refused('BAD_ROLE', 'use --role advisor, or leave --role off for an ordinary seat');
  if (values.role !== undefined && ctx.info.isMain) throw new Refused('BAD_ROLE', 'the main checkout is the coordinator, not an advisor; join an advisor from a worktree');
  const wake = seatWakeCommand(values.wake, ctx.info.root);
  const runtime = runtimeSessionIdentity();
  const parent = values.parent === undefined ? runtime?.parent : parentIdentity(values.parent);
  const parentDigest = parent ? parentSessionDigest(parent) : undefined;
  const sessionDigest = runtime?.session ? parentSessionDigest(runtime.session) : undefined;
  if (ctx.info.isMain) {
    if (first !== COORDINATOR) throw new Refused('MAIN_IS_COORDINATOR', 'the main checkout is the coordinator; join from a worktree: git worktree add ../<dir>');
    const model = requiredModel(values.model, environmentAdapter().all(), `join ${shellWord(COORDINATOR)}${values.route ? ` --route ${shellWord(values.route)}` : ''}${values.family ? ` --family ${shellWord(values.family)}` : ''}`);
    const route = values.route ?? 'strong'; // The coordinator is always strong, whatever tier its model name maps to.
    if (relayLinked(ctx.info.root)) refuseRemoteCoordinatorModel(ctx, 'join coordinator');
    const joined = await withBoard(ctx, async (board) => {
      const id = await ordered(ctx, board, 'register', [
        { lane: COORDINATOR, path: ctx.info.root, route, family: registeredFamily(values.family), model, parentDigest, sessionDigest },
      ]);
      return { id, boardId: store.boardId(board), family: seatFamily(board, id) };
    });
    registerProject(ctx.info.root, new Date(), ctx.config, projectBoardIdentity(ctx.info.root, joined.boardId));
    const id = joined.id;
    registerSeatWake(ctx.info, joined.boardId, id, wake);
    const displayName = displayAgentName({ agent_id: id, agent_model: model }, ctx.config.agents.names);
    io.result?.({ agent: id, lane: COORDINATOR, route, path: ctx.info.root, model, displayName, family: joined.family ?? null });
    io.say(`declared ${displayName}${joined.family ? ` (family ${joined.family})` : ''} in the coordinator lane`);
    io.say(`coordinator: read ${COORDINATOR_GUIDE_FILE} before you route anything`);
    return 0;
  }
  // join.coordinatorSeat (off by default, read here in the command layer): a second coordinator-lane seat in a worktree [#10573].
  const coordinatorSeat = first === COORDINATOR && joinCoordinatorSeat();
  if (!first || (first === COORDINATOR && !coordinatorSeat) || !isLane(ctx.config, first)) {
    throw new Refused('NO_LANE', `no lane "${first ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
  }
  const model = requiredModel(values.model, environmentAdapter().all(), `join ${shellWord(first)}${values.route ? ` --route ${shellWord(values.route)}` : ''}${values.family ? ` --family ${shellWord(values.family)}` : ''}`);
  const reviewLimits = String(values['review-limit'] ?? '').split(',').map(limit => limit.trim()).filter(Boolean);
  for (const limit of reviewLimits) {
    if (limit !== 'not-same-family') throw new Refused('BAD_REVIEW_LIMIT', `--review-limit ${limit} is not a review limit; the one limit is not-same-family`, 'pullboard join <lane> --review-limit not-same-family');
  }
  const existing = withBoardRead(ctx, board => store.agentAt(board, ctx.info.root));
  const sameSeat = existing?.agent_lane === first && existing.agent_model === model;
  const route = values.route ?? existing?.agent_route ?? environmentAdapter().get('PULLBOARD_ROUTE') ?? modelTierRoute(model, ctx.config.modelTiers);
  // Explicit registration updates must reach the board even when the seat identity is unchanged.
  if (sameSeat && values.family === undefined && values.route === undefined && values.wake === undefined && values.role === undefined && !values['lock-lane'] && values['review-limit'] === undefined) {
    const displayName = displayAgentName(existing, ctx.config.agents.names);
    io.result?.({ agent: existing.agent_id, lane: first, route: existing.agent_route, level: existing.agent_route, path: ctx.info.root,
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
    const id = await ordered(ctx, board, 'register', [{ lane: first, path: ctx.info.root, route, family: registeredFamily(values.family), model, parentDigest, sessionDigest, ...(coordinatorSeat ? { coordinatorSeat: true } : {}), ...(values['lock-lane'] ? { lockLane: true } : {}), ...(values.role === undefined ? {} : { role: values.role }), ...(reviewLimits.length ? { reviewLimits } : {}) }]);
    return { id, boardId: store.boardId(board), family: seatFamily(board, id) };
  });
  registerProject(projectRoot, new Date(), ctx.config, projectBoardIdentity(projectRoot, joined.boardId));
  const id = joined.id;
  registerSeatWake(ctx.info, joined.boardId, id, wake);
  const displayName = displayAgentName({ agent_id: id, agent_model: model }, ctx.config.agents.names);
  io.result?.({ agent: id, lane: first, route, level: route, path: ctx.info.root, model, displayName, family: joined.family ?? null, ...(values.role === undefined ? {} : { role: values.role }), ...(sameSeat ? { alreadyJoined: true } : {}) });
  io.say(sameSeat
    ? `already joined as ${displayName}${joined.family ? ` (family ${joined.family})` : ''}; run pullboard next`
    : `joined as ${displayName}${joined.family ? ` (family ${joined.family})` : ''} in the ${first} lane${values.role === undefined ? '' : ` as an ${values.role}`}${route === 'light' ? ', on the light route' : ''}${values['lock-lane'] ? ', locked to it: next never moves this seat to another lane' : ''}`);
  return 0;
}
