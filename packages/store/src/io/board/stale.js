import { applyStaleState } from "../../logic/board/stale/apply.js";
import { getItem } from "./query.js";
import { itemById } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { setItem } from "../board.js";
import { moveItem } from "../board.js";
import { releaseItemHold } from "./release/hold.js";
import { insertShout } from "./shout.js";

/** Apply one captured stale-state plan under authenticated coordinator authority. */
export function maintainStaleState(board, options) {
  return applyStaleState(board, options, { atomic, getItem, itemById, setItem, releaseItemHold, logEvent, insertShout, moveItem });
}
