/** Native proof receipt routing is pure; origin binding belongs to the engine adapter [C7,H16]. */
import { PROOF_RUN_ENGINE } from '../proof-run-engine.js';

/** Proof provenance always requires its own replay floor, regardless of optional metadata. */
function minimumEngine() { return PROOF_RUN_ENGINE; }

/** Attribute a recorded proof to its declared native seat. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'recordProofRun', order: 55, engine: PROOF_RUN_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  PROOF_RUN_UNAVAILABLE: 'restore writable native receipt storage, run the item check with current Pullboard, then read pullboard show <id>',
  PROOF_RUN_UNBOUND: 'run the item check with current Pullboard and use its stored native receipt; read pullboard show <id> for the proof chain',
  PROOF_RUN_ACTOR: 'run the check from your own joined seat and use the native receipt that belongs to that seat',
  PROOF_RUN_STALE: 'read pullboard show <id> for the current frozen criterion, then run a fresh item check',
  PROOF_RUN_CHANGED: 'preserve the original receipt and run a new item check to obtain a new native receipt id',
}) });
