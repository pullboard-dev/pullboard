import { applyItemReservation } from "../../../../../items/index.js";
import { now } from "../query.js";
import { getItem } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { coordinatorOnly } from "../../board.js";
import { setItem } from "../../board.js";

/** Reserve an item for a seat or block through the coordinator transaction; the event records the holder so replicas agree [C7,#9181]. */
export function reserveItem(board, id, options) {
  return applyItemReservation(board, id, options, { coordinatorOnly, atomic, getItem, setItem, now, logEvent });
}
