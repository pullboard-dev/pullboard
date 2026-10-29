/** Shared board access every command uses: the caller's board, its person mode and its queue seat. Split from src/cli.js, which re-exports it [C7]. */
import { createQueuedItemLease } from '../queued-item-lease.js';
import * as personIdentity from '../person.js';
import { barActorForCommand as commandBarActor } from '../bar-actor.js';
import * as store from '../board.js';
import { context } from '../cli-context.js';
import { withBoard } from '../cli-context.js';
import { CHECKOUT_BOARD_ONLY } from '../cli-main.js';
import { CHECKOUT_LEASES } from '../cli-main.js';
import { COORDINATOR } from '../config.js';
import { Refused } from '../refused.js';
import { runPrivateBoard } from '../private-board.js';
import { ordered } from './claim.js';
import { whoAmI } from './join.js';
import { claimFreezer } from './claim.js';

/** Preserve the public command facade while supplying actual query and person-channel capabilities. */
export function barActorForCommand(ctx, board, options = {}) {
  return commandBarActor(ctx, board, options, { agentAt: store.agentAt, requirePersonChannel: personIdentity.requirePersonChannel });
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
  const ctx = context(io);
  if (privateBoard) return runPrivateBoard(ctx, work, { withBoard, whoAmI,
    checkoutLeases: CHECKOUT_LEASES, checkoutBoardOnly: CHECKOUT_BOARD_ONLY });
  return withBoard(ctx, (board) => work(ctx, board, whoAmI(ctx, board)));
}

/** Name a known board seat for queue diagnostics without requiring an unjoined checkout to join. */
export function resourceAgent(ctx) {
  return ctx.info.isMain ? COORDINATOR : withBoard(ctx, board => store.agentAt(board, ctx.info.root)?.agent_id);
}

/** Keep the public queue adapter while its lease protocol lives in a bounded module. */
export function queuedItemLease(ctx, initial, agentId, kind, admission = null) {
  return createQueuedItemLease(ctx, initial, agentId, kind, admission, { getItem: store.getItem, withBoard, ordered, claimFreezer });
}

