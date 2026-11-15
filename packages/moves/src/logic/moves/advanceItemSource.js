import { checkTimingEngine } from "../../../../items/browser.js";
/** An autonomous trusted worker records a proved main merge without manufacturing a review [C7,V4,H16]. */
import { SOURCE_ADVANCE_ENGINE } from "../../../../state/light.js";
import { QUARANTINE_VERDICT_ENGINE } from "../../../../state/light.js";
/** The feature must be understood by every replay receiver. */
function minimumEngine(args, board) { return Math.max(SOURCE_ADVANCE_ENGINE, checkTimingEngine(board, args[0]),
  args[1]?.proof?.phases?.some(phase => Object.hasOwn(phase.receipt ?? {}, 'blockingVerdict')) ? QUARANTINE_VERDICT_ENGINE : 1); }
/** Only the ordinary coordinator transport may publish the worker result. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default Object.freeze({ operation: 'advanceItemSource', engine: SOURCE_ADVANCE_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor, nextSteps: Object.freeze({
    SOURCE_ADVANCE_STATE: 'restore the ordered source-advance history before using its effective head',
    SOURCE_ADVANCE_STALE: 'read the current item, bar, patches and main, then let the worker check the new exact composition',
    SOURCE_ADVANCE_PROOF: 'run the exact frozen check and every affected test through the ordinary gate on the clean composition',
    SOURCE_ADVANCE_SOURCE: 'restore the exact submitted and main Git objects; genuine source conflicts require a named return',
    SOURCE_ADVANCE_LIMIT: 'obtain a fresh independent review before extending this bounded source-advance chain'
  }) });
