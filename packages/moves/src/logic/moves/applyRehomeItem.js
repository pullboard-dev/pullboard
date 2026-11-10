import { frozenCheckTiming } from "../../../../items/light.js";
import { CHECK_TIMING_ENGINE } from "../../../../state/light.js";
import { REVIEW_INDEPENDENCE_ENGINE } from "../../../../state/light.js";
import { PRIVATE_REHOME_ENGINE } from "../../../../state/light.js";

/** Destination application uses the source identity as its idempotency key [H16]. */
function minimumEngine(args) { return Math.max((args[0]?.item?.item_check_timing !== undefined || frozenCheckTiming(args[0]?.item ?? {})) ? CHECK_TIMING_ENGINE : 1, args[0]?.reviewPolicy ? Math.max(PRIVATE_REHOME_ENGINE, REVIEW_INDEPENDENCE_ENGINE) : PRIVATE_REHOME_ENGINE); }
/** Destination replay is attributed to the authenticated local/relay actor [H2,H16]. */
function actor(move) { return move.args[1]?.destinationAgentId ?? move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: 'applyRehomeItem', order: 10002, engine: PRIVATE_REHOME_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    BAD_REVIEW_POLICY: 'restore the native review policy before reviewing this item',
    REHOME_CHECK: 'keep the source check unchanged and choose a destination board whose policy accepts it',
    REHOME_CONFLICT: 'keep the original source move ID and resolve the destination board conflict before retrying',
    REHOME_DESTINATION: 'apply the source move on its named destination board',
    REHOME_FORMAT: 'restore the exact source move record and retry it with an authorized destination handle',
    REHOME_ID: 'preserve the source MOVEID and its reserved destination ID; resolve the item-ID conflict before retrying',
    REHOME_LINKS: 'move each parent or wait item to this destination first, then retry the same source MOVEID',
    REHOME_PENDING: 'retry the same move ID and destination to finish delivery; do not allocate another destination ID',
    REHOME_VERDICT: 'keep the source board acceptance intact and inspect its exact commit, digest and verifier reference',
  }) });
