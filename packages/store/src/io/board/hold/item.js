import { holdUntilKind } from "../../../logic/board/holds.js";
import { forgetHoldMaintenance } from "../../../logic/board/holds.js";
import { rememberHoldCondition } from "../../../logic/board/holds.js";
import { applyItemHold } from "../../../../../items/index.js";
import { now } from "../query.js";
import { getItem } from "../query.js";
import { itemHold } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { coordinatorOnly } from "../../board.js";
import { postRigorNotices } from "../../board.js";
import { setItem } from "../../board.js";

/** Hold an item through the unchanged coordinator transaction. */
export function holdItem(board, id, options) {
  return applyItemHold(board, id, options, { coordinatorOnly, atomic, getItem, setItem, now, logEvent, postRigorNotices, itemHold, holdUntilKind, forgetHoldMaintenance, rememberHoldCondition, staleStateEngine: board.nativePorts.staleStateEngine });
}
