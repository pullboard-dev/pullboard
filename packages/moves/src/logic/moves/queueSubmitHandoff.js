/** Routing for an observational queued-submit move; no gate authority is added [C7,V4,H16]. */
import { SUBMIT_HANDOFF_ENGINE } from "../../../../state/light.js";
/** New queued moves never replay as an older synchronous submission. */
function minimumEngine() { return SUBMIT_HANDOFF_ENGINE; }
/** Retain the existing sender-to-actor binding. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default Object.freeze({ operation: 'queueSubmitHandoff', engine: SUBMIT_HANDOFF_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
    SUBMIT_HANDOFF_SOURCE: 'submit the clean registered candidate on its own native board',
    SUBMIT_HANDOFF_AUTHORITY: 'read the queued result; workers cannot change another item or sender',
    BAD_SUBMIT_HANDOFF: 'read the captured candidate and current job with pullboard show <id>, then submit the clean committed source again',
    SUBMIT_HANDOFF_CHANGED: 'read the current claim and queued result with pullboard show <id>; do not complete an old or foreign job',
    SUBMIT_HANDOFF_PENDING: 'leave the queued source unchanged; take other work with pullboard next; nothing for this seat: end your turn',
    SUBMIT_HANDOFF_RESULT: 'retain the normal gate receipts and submission result; a queue record never replaces a proved submit',
  }),
});
