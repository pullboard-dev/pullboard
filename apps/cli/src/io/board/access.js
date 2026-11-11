import { seatAt } from '../item/folder/identity.js';
import { submitHandoffActor } from '../../../../../packages/sandbox/index.js';
/** Shared board access every command uses: the caller's board, its person mode and its queue seat. Split from src/cli.js, which re-exports it [C7]. */
import { createQueuedItemLease } from '../../../../../packages/git/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import { barActorForCommand as commandBarActor } from '../../../../../packages/verify/index.js';
import * as store from '../../../../../packages/store/index.js';
import { personCommandContext } from '../context.js';
import { withBoard } from '../context.js';
import { nativeBoardOpeners } from '../context.js';
import { CHECKOUT_BOARD_ONLY } from '../main.js';
import { CHECKOUT_LEASES } from '../main.js';
import { main } from '../main.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { runPrivateBoard } from '../../../../../packages/github/index.js';
import { relayMachineOwner } from '../../../../../packages/link/index.js';
import { relayMachineContext } from '../../../../../packages/link/index.js';
import { ordered } from '../claim.js';
import { whoAmI } from '../join.js';
import { claimFreezer } from '../claim.js';

/** Preserve the public command facade while supplying actual query and person-channel capabilities. */
export function barActorForCommand(ctx, board, options = {}) {
  return commandBarActor(ctx, board, options, { agentAt: seatAt, requirePersonChannel: requirePersonChannel });
}
/**
 * Select the person actor only through the main checkout's explicit person mode (B26).
 *
 * @param {any} ctx
 * @param {{ id: string }} me
 * @param {{ as?: string }} values
 * @returns {boolean}
 */
export function personMode(ctx, me, values) {
  if (values.as === undefined) return false;
  if (values.as !== 'person') throw new Refused('USAGE', '--as person is supported for answer, decisions, hold and fact --never-again');
  if (!ctx.info.isMain || me.id !== COORDINATOR) {
    throw new Refused('B26_PERSON_ANSWER', 'only the main checkout can act as the person; ask your coordinator to answer or pass this decision');
  }
  return true;
}
/** Run board work for the caller's checkout, or select its device-local repo board for a private add. */
export function actOn(io, work, { privateBoard = false } = {}) {
  const ctx = personCommandContext(io, { main, ordered });
  if (privateBoard) return runPrivateBoard(ctx, work, { withBoard, whoAmI,
    checkoutLeases: CHECKOUT_LEASES, checkoutBoardOnly: CHECKOUT_BOARD_ONLY, relayMachineOwner, relayMachineContext, ...nativeBoardOpeners(io) });
  return withBoard(ctx, (board) => work(ctx, board, whoAmI(ctx, board)));
}

/** Name a known board seat for queue diagnostics without requiring an unjoined checkout to join. */
export function resourceAgent(ctx) {
  return ctx.info.isMain ? COORDINATOR : withBoard(ctx, board => (submitHandoffActor(ctx, board) ?? seatAt(board, ctx.info.root))?.agent_id);
}

/** Keep the public queue adapter while its lease protocol lives in a bounded module. */
export function queuedItemLease(ctx, initial, agentId, kind, admission = null) {
  const report = createQueuedItemLease(ctx, initial, agentId, kind, admission, { getItem: store.getItem, withBoard, ordered, claimFreezer, gateWaitReporter: io => io.gateWaitReporter(io) });
  let finish;
  return async state => {
    if (!state.admitted && !finish) {
      const { beginSeatTiming } = await import('../../../../../packages/seats/light.js');
      finish = beginSeatTiming(ctx.info.root, 'runner-wait', 'gate slot');
    } else if (state.admitted && finish) { finish(); finish = null; }
    return report(state);
  };
}


