import { applyClearReservation } from "../../../../../items/index.js";
import { getItem } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { coordinatorOnly } from "../../board.js";
import { setItem } from "../../board.js";

/** Clear an item reservation through the coordinator transaction; the event keeps the holder it removed so replicas agree [C7,#9176]. */
export function clearReservation(board, id, options) {
  return applyClearReservation(board, id, options, { coordinatorOnly, atomic, getItem, setItem, logEvent });
}
