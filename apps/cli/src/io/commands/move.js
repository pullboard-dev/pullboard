/** Move one item between this repo's team and device-local boards [E14,E15]. */
import { randomUUID } from 'node:crypto';
import * as store from '../../../../../packages/store/index.js';
import { localBoardInventory } from '../../../../../packages/store/index.js';
import { resolveLocalBoard } from '../../../../../packages/store/index.js';
import { resolveLocalItemReference } from '../../../../../packages/store/index.js';
import { runPrivateBoard } from '../../../../../packages/github/index.js';
import { nativeBoardOpeners } from '../context.js';
import { projectBoardIdentity } from '../../../../../packages/seats/index.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { relayMachineOwner } from '../../../../../packages/link/index.js';
import { relayMachineContext } from '../../../../../packages/link/index.js';
import { relayCommandReceipt } from '../../../../../packages/link/index.js';
import { relayCommandReceiptReported } from '../../../../../packages/link/index.js';
import { assertRehomeSourceItemOrdered } from '../../../../../packages/link/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { CHECKOUT_BOARD_ONLY } from '../main.js';
import { CHECKOUT_LEASES } from '../main.js';
import { actOn } from '../entry.js';
import { ordered } from '../entry.js';
import { primaryCheckoutRoot } from '../entry.js';
import { whoAmI } from '../entry.js';
import { withBoard } from '../entry.js';

/** Run an operation against one of the current repo's authorized team/private boards. */
async function withLocalBoard(ctx, teamBoard, teamAgent, currentBoardId, reference, work) {
  if (reference.kind === 'team') {
    if (reference.boardId !== currentBoardId) throw new Refused('BOARD_REFERENCE', 'open a joined checkout of the referenced repo before moving its items');
    return work(ctx, teamBoard, teamAgent);
  }
  if (reference.repoBoardId !== currentBoardId) throw new Refused('BOARD_REFERENCE', 'open the repo checkout that owns this private board before moving its items');
  if (ctx.privateBoard) return withBoard(ctx, board => work(ctx, board, whoAmI(ctx, board)));
  return runPrivateBoard(ctx, work, { withBoard, whoAmI, checkoutLeases: CHECKOUT_LEASES, checkoutBoardOnly: CHECKOUT_BOARD_ONLY, relayMachineOwner, relayMachineContext, ...nativeBoardOpeners(ctx.io) });
}

/** Run an internal ordered operation without reusing the outer CLI command's relay receipt. */
function internalOperationContext(ctx) {
  const io = { ...ctx.io, relayCommand: undefined };
  for (const leases of [CHECKOUT_LEASES, CHECKOUT_BOARD_ONLY]) {
    if (leases.has(ctx.io)) leases.set(io, leases.get(ctx.io));
  }
  return { ...ctx, io };
}

/** Render only the authorized handle used in the command's receipt and old-ID redirect. */
function referenceName(reference) {
  return `${reference.kind === 'private' ? '~' : ''}${reference.organization}/${reference.handle}`;
}

/** Apply one move from the selected current board while retaining the repo board for local handles. */
async function moveFromContext(io, teamCtx, currentCtx, teamBoard, teamAgent, currentBoard, { first, values }) {
    const teamBoardId = store.boardId(teamBoard);
    const projectRoot = primaryCheckoutRoot(teamCtx.info);
    if (!projectRoot) throw new Refused('NO_POLICY', 'cannot safely register the project without locating its main checkout; restore Git worktree metadata and retry the move');
    registerProject(projectRoot, new Date(), teamCtx.config, projectBoardIdentity(projectRoot, teamBoardId));
    const inventory = await localBoardInventory(nativeBoardOpeners(io));
    const sourceRef = resolveLocalItemReference(inventory, first, store.boardId(currentBoard));
    const sourceBoardRef = inventory.find(entry => entry.boardId === sourceRef.boardId);
    if (!sourceBoardRef) throw new Refused('BOARD_REFERENCE', 'use a team handle recorded at init or join, or this repo’s signed-in private handle');
    if (typeof values.to !== 'string' || !values.to) throw new Refused('USAGE', 'pullboard move <item reference> --to <handle>');
    const destinationRef = resolveLocalBoard(inventory, values.to);
    if (destinationRef.boardId === sourceRef.boardId) throw new Refused('REHOME_SAME_BOARD', 'choose a different local board');

    if (sourceBoardRef.kind === 'team') {
      await assertRehomeSourceItemOrdered(teamCtx.info.root, sourceRef.itemId, teamCtx.io);
    }

    const sourceItem = await withLocalBoard(sourceBoardRef.kind === 'team' ? teamCtx : currentCtx,
      teamBoard, teamAgent, teamBoardId, sourceBoardRef,
      (_sourceCtx, sourceBoard) => {
        const previous = store.itemRedirect(sourceBoard, sourceRef.itemId);
        return previous?.item ?? store.getItem(sourceBoard, sourceRef.itemId);
      });
    if (!['open', 'verified'].includes(sourceItem.item_status)) {
      throw new Refused('REHOME_STATE', `item #${sourceRef.itemId} is ${sourceItem.item_status}; move open or verified items only`);
    }
    const linkedIds = [...(sourceItem.item_parent_id === null ? [] : [sourceItem.item_parent_id]),
      ...(sourceItem.item_after ? sourceItem.item_after.split(',').map(value => value.trim())
        .filter(value => /^\d+$/u.test(value)).map(Number) : [])];
    if (linkedIds.length) {
      const unresolved = await withLocalBoard(destinationRef.kind === 'team' ? teamCtx : currentCtx,
        teamBoard, teamAgent, teamBoardId, destinationRef,
        (_destinationCtx, destinationBoard) => linkedIds.filter(id => !store.rehomeDestinationItemId(destinationBoard, sourceRef.boardId, id)));
      if (unresolved.length) throw new Refused('REHOME_LINKS', `move linked item${unresolved.length === 1 ? '' : 's'} ${unresolved.map(id => `#${id}`).join(', ')} to ${referenceName(destinationRef)} first`);
    }

    const resumed = await withLocalBoard(sourceBoardRef.kind === 'team' ? teamCtx : currentCtx,
      teamBoard, teamAgent, teamBoardId, sourceBoardRef,
      (sourceCtx, sourceBoard, sourceAgent) => {
        const previous = store.itemRedirect(sourceBoard, sourceRef.itemId);
        if (previous && previous.destinationBoardId !== destinationRef.boardId) {
          throw new Refused('REHOME_PENDING', `item #${sourceRef.itemId} already has a pending move to ${previous.destinationHandle ?? previous.destinationBoardId}#${previous.destinationItemId}; retry that same destination`);
        }
        return { previous, sourceCtx, sourceAgent };
      });
    const commandReceipt = sourceBoardRef.kind === 'team'
      ? await relayCommandReceipt(teamCtx.info.root, teamCtx.io.relayCommand, teamCtx.io) : null;
    let moveId = commandReceipt?.move.id ?? resumed.previous?.moveId ?? randomUUID();
    let destinationItemId = resumed.previous?.destinationItemId;
    const destinationHandle = referenceName(destinationRef);
    let record = commandReceipt?.result ?? null;
    if (commandReceipt) {
      destinationItemId = record?.destinationItemId;
      if (!record || record.destinationBoardId !== destinationRef.boardId) {
        throw new Refused('REHOME_PENDING', 'retry the same destination named in the recorded source MOVEID');
      }
    } else if (!destinationItemId) {
      destinationItemId = await withLocalBoard(destinationRef.kind === 'team' ? teamCtx : currentCtx,
        teamBoard, teamAgent, teamBoardId, destinationRef,
        async (destinationCtx, destinationBoard, destinationAgent) => ordered(internalOperationContext(destinationCtx),
          destinationBoard, 'reserveRehomeItemId', [sourceRef.boardId, moveId, { agentId: destinationAgent.id }]));
    }

    if (!commandReceipt) {
      const sourceOptions = { agentId: resumed.sourceAgent.id, sourceMoveId: moveId,
        sourceHandle: referenceName(sourceBoardRef), destinationBoardId: destinationRef.boardId,
        destinationItemId, destinationHandle };
      resumed.sourceCtx.io.rehomeMoveId = moveId;
      record = await withLocalBoard(sourceBoardRef.kind === 'team' ? teamCtx : currentCtx,
        teamBoard, teamAgent, teamBoardId, sourceBoardRef,
        (sourceCtx, sourceBoard) => ordered(sourceCtx, sourceBoard, 'rehomeItem', [sourceRef.itemId, sourceOptions]));
    }
    if (!record || record.moveId !== moveId || record.destinationBoardId !== destinationRef.boardId
        || record.destinationItemId !== destinationItemId) {
      throw new Refused('REHOME_CONFLICT', 'resume the exact source MOVEID and destination ID recorded on the source board');
    }
    io.recordedMove = true;

    const destinationId = await withLocalBoard(destinationRef.kind === 'team' ? teamCtx : currentCtx,
      teamBoard, teamAgent, teamBoardId, destinationRef,
      async (destinationCtx, destinationBoard, destinationAgent) => {
        const deliveryIo = { ...destinationCtx.io, relayCommand: undefined, rehomeMoveId: undefined };
        for (const leases of [CHECKOUT_LEASES, CHECKOUT_BOARD_ONLY]) {
          if (leases.has(destinationCtx.io)) leases.set(deliveryIo, leases.get(destinationCtx.io));
        }
        const deliveryCtx = { ...destinationCtx, io: deliveryIo };
        let id;
        try {
          id = await ordered(deliveryCtx, destinationBoard, 'applyRehomeItem', [record, { destinationAgentId: destinationAgent.id }]);
        } catch (error) {
          if (error instanceof Refused && /^RELAY_/u.test(error.code)) {
            throw new Refused('REHOME_PENDING', `the source move ${moveId} is recorded; retry this same move and destination to finish delivery`);
          }
          throw error;
        }
        if (deliveryCtx.io.recordedMove) io.recordedMove = true;
        return id;
      });
    if (sourceBoardRef.kind === 'team' && teamCtx.io.relayCommand && (commandReceipt || io.recordedMove)) {
      await relayCommandReceiptReported(teamCtx.info.root, moveId, teamCtx.io);
    }
    io.result?.({ source: `${referenceName(sourceBoardRef)}#${sourceRef.itemId}`,
      destination: `${destinationHandle}#${destinationId}`, moveId, item: record });
    io.say(`${referenceName(sourceBoardRef)}#${sourceRef.itemId} moved to ${destinationHandle}#${destinationId}`);
    return 0;
}

/** Run `pullboard move <item reference> --to <handle>` and return its exit code. */
export async function run(io, args) {
  return actOn(io, async (ctx, teamBoard, teamAgent) => {
    if (!args.values.private) return moveFromContext(io, ctx, ctx, teamBoard, teamAgent, teamBoard, args);
    return runPrivateBoard(ctx, (privateCtx, privateBoard, privateAgent) =>
      moveFromContext(io, ctx, privateCtx, teamBoard, teamAgent, privateBoard, args),
    { withBoard, whoAmI, checkoutLeases: CHECKOUT_LEASES, checkoutBoardOnly: CHECKOUT_BOARD_ONLY, relayMachineOwner, relayMachineContext, ...nativeBoardOpeners(ctx.io) });
  });
}
