/** A train landing seals its native gate and uses the ordinary batch finishing writer [C7,H16]. */
import { TRAIN_LANDING_ENGINE } from '../train-landing-engine.js';

/** The sealed receipt payload has no interpretation on an older replay engine. */
function minimumEngine() { return TRAIN_LANDING_ENGINE; }

/** Read the coordinator identity from the sealed request. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'recordTrainLanding', engine: TRAIN_LANDING_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    LAND_RECEIPT_UNBOUND: 'run pullboard gate --landing on the exact clean envelope, then record its native receipt ID',
    LAND_RECEIPT_REQUIRED: 'pass --gate-receipt with the native landing gate receipt ID',
  }) });
