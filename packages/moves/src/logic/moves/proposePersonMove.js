/** Routing metadata owned by proposePersonMove, which records a terminal-started person move for the passkey device to confirm [E22,H16]. */
import { PERSON_SIGNING_ENGINE } from "../../../../state/light.js";

/** Signed person moves arrived with their own engine; nothing older can replay this operation [H16]. */
function minimumEngine() { return PERSON_SIGNING_ENGINE; }

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "proposePersonMove", engine: PERSON_SIGNING_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({}) });
