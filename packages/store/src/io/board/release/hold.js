import { forgetHoldMaintenance } from "../../../logic/board/holds.js";
import { applyItemHoldRelease } from "../../../../../items/index.js";
import { itemHold } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { coordinatorOnly } from "../../board.js";
import { setItem } from "../../board.js";

/** Lift an item hold through its existing native operation. */
export function releaseItemHold(board, id, options) {
  return applyItemHoldRelease(board, id, options, { coordinatorOnly, atomic, itemHold, setItem, logEvent, forgetHoldMaintenance });
}
