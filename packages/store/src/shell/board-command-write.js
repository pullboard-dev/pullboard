import { requireExitActive } from "../core/exit-rules-state.js";
/** The native command prepares external work before its final ordered writer [B2,C7]. */
import * as store from "./board.js";
import { measureBoardWritePhase } from './board-write-lock.js';
import { requireHandoffActive } from "../../../state/src/core/handoff-state.js";
import { requireAgentGrant } from "../../../state/index.js";
import { ENGINE_VERSION } from "../../../../src/engine-metadata.js";
import { Refused } from "../../../kernel/index.js";

const PREPARE_ATTEMPTS = 4;

// Like the writer dispatch, each preparation belongs to its exact native operation, never the wire.
const PREPARATIONS = Object.freeze({ claim: store.prepareClaim, queueSubmitHandoff: store.prepareQueueSubmitHandoff });

/**
 * Preserve native authority before preparation and revalidate it under the actual writer lock.
 * @param {any} board
 * @param {string} operation
 * @param {any[]} args
 * @param {string|undefined} actor
 * @returns {any}
 */
export function writeBoardCommand(board, operation, args, actor, { prepareInWriter } = {}) {
  requireHandoffActive(board, actor, operation, args);
  requireExitActive(board, actor, operation, args);
  requireAgentGrant(board, { operation, args, engine: ENGINE_VERSION });
  const prepare = PREPARATIONS[operation];
  // Another connection's commit (a peer's renewal, a baseline worker) can land between preparation and
  // the writer lock; the prepared plan is then stale, so prepare again from the new board. Bounded so a
  // continuously changing board still reports BOARD_BUSY. This is why concurrent renewals all succeed.
  for (let attempt = 0; ; attempt++) {
    let preparing = true;
    let rollbackPrepared;
    try {
      const prepared = prepare ? [args[0], prepare(board, args[0], args[1])] : args;
      preparing = false;
      return store.atomic(board, () => {
        const writerResult = prepareInWriter ? prepareInWriter(board) : null;
        if (writerResult && typeof writerResult.then === 'function') throw new TypeError('board writer preparation must be synchronous');
        rollbackPrepared = typeof writerResult?.rollback === 'function' ? writerResult.rollback : undefined;
        if (writerResult && (!Array.isArray(writerResult.args)
          || writerResult.rollback !== undefined && typeof writerResult.rollback !== 'function')) {
          throw new TypeError('board writer preparation must return args and an optional rollback function');
        }
        const current = writerResult ? writerResult.args : prepared;
        if (writerResult) args.splice(0, args.length, ...current);
        measureBoardWritePhase(board.db, 'handoff-guard', () => requireHandoffActive(board, actor, operation, current));
        measureBoardWritePhase(board.db, 'exit-guard', () => requireExitActive(board, actor, operation, current));
        measureBoardWritePhase(board.db, 'agent-grant', () => requireAgentGrant(board, { operation, args: current, engine: ENGINE_VERSION }));
        return measureBoardWritePhase(board.db, 'native-move', () => board.enginePorts.store[operation](board, ...current));
      });
    } catch (error) {
      rollbackPrepared?.();
      // Claim preparation already owns its bounded retries; only queue sealing needs this outer retry.
      if (preparing && operation !== 'queueSubmitHandoff') throw error;
      if (!prepare || !(error instanceof Refused) || error.code !== 'BOARD_BUSY' || attempt >= PREPARE_ATTEMPTS - 1) throw error;
    }
  }
}
