import { requireExitActive } from "../../logic/exit/rules/claim.js";
/** The native command prepares external work before its final ordered writer [B2,C7]. */
import * as store from "../board.js";
import { measureBoardWritePhase } from './write/lock.js';
import { observedWriterRecords } from './write/preparation.js';
import { prepareReserveNextReview } from "./reserve/next.js";
import { prepareReserveReview } from "./reserve/review.js";
import { requireHandoffActive } from "../../../../state/light.js";
import { requireAgentGrant } from "../../../../state/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { REVIEW_GATE_RECEIPT_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/index.js";

const PREPARE_ATTEMPTS = 4;

// Like the writer dispatch, each preparation belongs to its exact native operation, never the wire.
// Each returns the writer's arguments: item moves prepare their options; next --verify prepares its selection and a
// named reservation its witness, so no candidate scan or witness build runs in the writer's transaction (#3156).
const PREPARATIONS = Object.freeze({
  claim: (board, args) => [args[0], store.prepareClaim(board, args[0], args[1])],
  queueSubmitHandoff: (board, args) => [args[0], store.prepareQueueSubmitHandoff(board, args[0], args[1])],
  reserveNextReview: (board, args) => [prepareReserveNextReview(board, args[0]), ...args.slice(1)],
  reserveReview: (board, args) => [args[0], prepareReserveReview(board, args[0], args[1]), ...args.slice(2)],
  // A verdict on work whose gate has no captured receipt is refused before any write transaction opens (#5561).
  verify: (board, args) => { refuseUnreceiptedVerdict(board, args[0]); return args; },
  // Gate-run and flake writes read every earlier run; read them here so the writer reads only the runs since (#2294).
  recordGateRun: (board, args) => { warmHistories(board); return args; },
  recordFlakeObservation: (board, args) => { warmHistories(board); return args; },
});

/**
 * Refuse a verdict whose gate has no captured proof receipt, reading with no lock held; the writer checks it again.
 * Why: a refusal rolls back, yet it still held the board's one write lock while it read the receipts (#5561).
 */
function refuseUnreceiptedVerdict(board, id) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_GATE_RECEIPT_ENGINE) return;
  const problem = store.gateReceiptProblem(board, store.getItem(board, id) ?? {});
  if (problem) throw problem;
}

/** Read the shared gate-run and flake histories with no lock held. */
function warmHistories(board) {
  board.enginePorts.store.gateRuns(board);
  board.enginePorts.store.flakeLedger(board);
}

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
      const prepared = prepare ? prepare(board, args) : args;
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
        return measureBoardWritePhase(board.db, 'native-move', () => board.enginePorts.store[operation](board, ...current), operation);
      });
    } catch (error) {
      rollbackPrepared?.();
      // Claim preparation already owns its bounded retries; only queue sealing needs this outer retry.
      if (preparing && operation !== 'queueSubmitHandoff') throw observedWriterRecords(error);
      // The lock is released here, so a final refusal can read the machine write log to name its writer (#6016).
      if (!prepare || !(error instanceof Refused) || error.code !== 'BOARD_BUSY' || attempt >= PREPARE_ATTEMPTS - 1) throw observedWriterRecords(error);
      // Jitter outside the rolled-back transaction, so contending preparations stop retrying in step (#6016).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 25 * (attempt + 1)));
    }
  }
}
