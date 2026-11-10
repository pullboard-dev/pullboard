import { FLAKE_RATCHET_ENGINE } from '../../../../state/light.js';
import { QUARANTINE_VERDICT_ENGINE } from "../../../../state/light.js";
/** A train landing seals its native gate and uses the ordinary batch finishing writer [C7,H16]. */
import { TRAIN_LANDING_ENGINE } from "../../../../state/light.js";
import { TRAIN_CHECK_REPOINT_ENGINE } from "../../../../state/light.js";

/** The sealed receipt payload has no interpretation on an older replay engine. */
function minimumEngine(args) { return Math.max(TRAIN_LANDING_ENGINE, args[0]?.batch?.flakeRatchet ? FLAKE_RATCHET_ENGINE : 1,
  Object.hasOwn(args[0]?.receipt ?? {}, 'blockingVerdict') ? QUARANTINE_VERDICT_ENGINE : 1,
  args[0]?.checkRepointPlan ? TRAIN_CHECK_REPOINT_ENGINE : 1); }

/** Read the coordinator identity from the sealed request. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'recordTrainLanding', engine: TRAIN_LANDING_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    LAND_RECEIPT_UNBOUND: 'run pullboard gate --landing on the exact clean envelope, then record its native receipt ID',
    LAND_RECEIPT_REQUIRED: 'pass --gate-receipt with the native landing gate receipt ID',
  }) });
