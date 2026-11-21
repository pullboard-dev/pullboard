/** Routing owned by clearReviewReservation; an older engine never recorded the clear and refuses it [C7,H16]. */
import { CLEAR_REVIEW_RESERVATION_ENGINE } from "../../../../state/light.js";
/** Clearing a review reservation is only meaningful on an engine that records the clear. */
function minimumEngine() { return CLEAR_REVIEW_RESERVATION_ENGINE; }
/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default Object.freeze({ operation: "clearReviewReservation", order: 10013, engine: CLEAR_REVIEW_RESERVATION_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
    "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
    "NOT_SUBMITTED": "see its state with pullboard show <id>; verify only submitted items: pullboard next --verify",
    "USAGE": "run pullboard help"
  }) });
