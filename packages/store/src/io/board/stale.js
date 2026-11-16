import { applyStaleState } from "../../logic/board/stale/apply.js";
import { getItem } from "./query.js";
import { itemById } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { setItem } from "../board.js";
import { moveItem } from "../board.js";
import { releaseItemHold } from "./release/hold.js";
import { insertShout } from "./shout.js";
import { shadowSetting } from "./submit.js";
import { shadowHook } from "./shadow-record.js";
import { reclaimDecision } from "./reclaim-table.js";
import { reclaimDiffers } from "./reclaim-table.js";

/**
 * Apply one captured stale-state plan under authenticated coordinator authority.
 * With moves.shadow on (or a test's `reclaimShadow`), the reclaim table decides each row maintenance acts on and the compare is recorded [C7,#9367].
 */
export function maintainStaleState(board, options) {
  const hook = shadowHook(board, 'reclaimShadow', 'reclaim', reclaimDiffers, shadowSetting);
  return applyStaleState(board, options, { atomic, getItem, itemById, setItem, releaseItemHold, logEvent, insertShout, moveItem, reclaim: hook ? { hook, decide: reclaimDecision } : null });
}
