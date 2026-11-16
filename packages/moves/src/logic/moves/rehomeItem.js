import { checkTimingEngine } from "../../../../items/browser.js";
import { itemReviewPolicy } from "../../../../verify/browser.js";
import { REVIEW_INDEPENDENCE_ENGINE } from "../../../../state/light.js";
import { PRIVATE_REHOME_ENGINE } from "../../../../state/light.js";

/** Preserve the ordered source move ID in its arguments for idempotent destination application. */
function minimumEngine(args, board) { return Math.max(checkTimingEngine(board, args[0]), board && itemReviewPolicy(board, args[0]).tier === 'strict' ? Math.max(PRIVATE_REHOME_ENGINE, REVIEW_INDEPENDENCE_ENGINE) : PRIVATE_REHOME_ENGINE); }
/** Read the actor from the re-home options [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: 'rehomeItem', order: 10001, engine: PRIVATE_REHOME_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
    BAD_REVIEW_POLICY: 'restore the native review policy before reviewing this item',
    ITEM_MOVED: 'use the recorded destination reference shown in the refusal; do not move the old ID again',
    REHOME_PENDING: 'retry the same move ID and destination to finish delivery; do not allocate another destination ID',
    REHOME_FORMAT: 'restore the exact source move record and retry it with an authorized destination handle',
    REHOME_LINKS: 'move each parent or wait item to this destination first, then retry the same source MOVEID',
    REHOME_SAME_BOARD: 'choose a different local board',
    REHOME_STATE: 'open or verified items can move; keep other items on their current board',
  }) });
