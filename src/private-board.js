import { seatFamily } from './family-declaration.js';
/** Select a repo's device-local board for an add without changing the shared repo board [E11,E13]. */
import * as store from './board.js';
import { withPrivateBoard } from './projects.js';
import { originRepository } from './github-origin.js';
import { relayMachineOwner } from './relay-machine.js';
import { relayStatus } from './relay.js';
import { Refused } from './refused.js';

/** Run one add on its device-local board while keeping the repo checkout's own seat binding. */
export function runPrivateBoard(ctx, work, { withBoard, whoAmI, checkoutLeases, checkoutBoardOnly }) {
  return withBoard(ctx, async (repoBoard) => {
    const repoActor = whoAmI(ctx, repoBoard);
    const repository = originRepository(ctx.info.root, { optional: true });
    const [repoOwner, repoName] = repository?.split('/') ?? [];
    let signedOwner = null;
    try {
      const machineOwner = relayMachineOwner();
      signedOwner = machineOwner ? machineOwner.login : relayStatus(ctx.info.root)?.login;
    } catch { /* Missing readable sign-in metadata is refused below. */ }
    if (!signedOwner) throw new Refused('AUTH_REQUIRED', 'sign in to GitHub with pullboard relay on before creating a private-board reference');
    return withPrivateBoard(store.boardId(repoBoard), async (board, file) => {
      const privateIo = { ...ctx.io, relayCommand: undefined,
        requestedCommand: ctx.io.relayCommand?.cliOperation ?? ctx.io.requestedCommand };
      const checkoutLease = checkoutLeases.get(ctx.io);
      if (checkoutLease) checkoutLeases.set(privateIo, checkoutLease);
      const boardOnly = checkoutBoardOnly.get(ctx.io);
      if (boardOnly) checkoutBoardOnly.set(privateIo, boardOnly);
      const privateCtx = { ...ctx, io: privateIo, file, allowSchemaUpgrade: true, privateBoard: true };
      if (ctx.info.isMain) store.ensureCoordinator(board, ctx.info.root);
      else if (!store.agentAt(board, ctx.info.root)) store.register(board, {
        lane: repoActor.lane,
        path: ctx.info.root,
        route: repoActor.route,
        family: repoActor.family,
        model: repoActor.model,
        createdBy: 'machine',
      });
      const actor = store.agentAt(board, ctx.info.root);
      try {
        return await work(privateCtx, board, { id: actor.agent_id, lane: actor.agent_lane, route: actor.agent_route,
          family: seatFamily(board, actor.agent_id), model: actor.agent_model });
      } finally {
        if (privateIo.recordedMove) ctx.io.recordedMove = true;
      }
    }, { create: true, clock: ctx.clock, reference: repository ? { handle: repoName, organization: repoOwner, owner: signedOwner } : null });
  });
}
