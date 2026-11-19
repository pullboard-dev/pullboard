/** Routing for a queued gate recapture that hands its submit off after the earlier queued submit replay; no gate authority is added [C7,H16]. */
import { RECAPTURE_SUBMIT_HANDOFF_ENGINE } from '../../../../state/light.js';
/** A recapture hand-off never replays under an engine older than its own leaf. */
function minimumEngine() { return RECAPTURE_SUBMIT_HANDOFF_ENGINE; }
/** Retain the existing sender-to-actor binding. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default Object.freeze({ operation: 'recaptureSubmitHandoff', engine: RECAPTURE_SUBMIT_HANDOFF_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
    SUBMIT_HANDOFF_CHANGED: 'read the current claim and queued result with pullboard show <id>; do not complete an old or foreign job',
    BAD_SUBMIT_HANDOFF: 'read the captured candidate and current job with pullboard show <id>, then submit the clean committed source again',
  }),
});
