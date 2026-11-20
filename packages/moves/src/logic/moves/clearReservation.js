/** Routing owned by clearReservation; an older engine has no reservation to clear and refuses it [C7,H16]. */
import { RESERVATION_ENGINE } from "../../../../state/light.js";
/** Clearing is only meaningful on an engine that records reservations. */
function minimumEngine() { return RESERVATION_ENGINE; }
/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default Object.freeze({ operation: "clearReservation", order: 10013, engine: RESERVATION_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
    "ITEM_NOT_OPEN": "hold only open or claimed items; see pullboard list",
    "USAGE": "run pullboard help"
  }) });
