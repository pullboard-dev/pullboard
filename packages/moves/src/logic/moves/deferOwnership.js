/** Owner waiting is a source-bound routing result, never a submission or approval [B3,L1,V4]. */
import { OWNERSHIP_WAIT_ENGINE } from '../../../../state/light.js';

/** Old engines cannot interpret the new routing receipt. */
function minimumEngine() { return OWNERSHIP_WAIT_ENGINE; }

/** The original builder alone can route its proved source. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: 'deferOwnership', engine: OWNERSHIP_WAIT_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
    OWNERSHIP_WAIT_INVALID: 'keep the captured source and ask its owner to inspect the ownership wait',
    OWNERSHIP_WAIT_PROOF: 'submit through the native gate; only exact-source green receipts can route ownership',
    OWNERSHIP_WAIT_SOURCE: 'preserve the source and submit again from its native item context',
  }) });
