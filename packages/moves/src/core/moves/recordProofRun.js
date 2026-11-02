import { SUBMIT_PROOF_REUSE_ENGINE } from '../../../../../src/submit-proof-reuse-engine.js';
import { EXIT_RULES_ENGINE } from "../../../../state/core.js";
import { ITEM_PATCH_SUBMIT_ENGINE } from "../../../../../src/item-patch-submit-engine.js";
/** Native proof receipt routing is pure; origin binding belongs to the engine adapter [C7,H16]. */
import { PROOF_RUN_ENGINE } from "../../../../../src/proof-run-engine.js";
import { SUBMIT_ADMISSION_ENGINE } from "../../../../../src/submit-admission-engine.js";
import { QUARANTINE_VERDICT_ENGINE } from "../../../../../src/quarantine-verdict-engine.js";

/** Proof provenance always requires its own replay floor, regardless of optional metadata. */
function minimumEngine(args) { if (args[0]?.receipt?.proof?.submitReuse === true) return SUBMIT_PROOF_REUSE_ENGINE; if (args[0]?.exitFailures === true) return EXIT_RULES_ENGINE; return Object.hasOwn(args[0]?.receipt ?? {}, 'blockingVerdict') ? QUARANTINE_VERDICT_ENGINE : args[0]?.receipt?.proof?.submitPhase ? ITEM_PATCH_SUBMIT_ENGINE : args[0]?.receipt?.proof?.submitAdmission ? SUBMIT_ADMISSION_ENGINE : PROOF_RUN_ENGINE; }

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
