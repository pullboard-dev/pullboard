import { holdUntilKind } from "../../../logic/board/holds.js";
import { forgetHoldMaintenance } from "../../../logic/board/holds.js";
import { rememberHoldCondition } from "../../../logic/board/holds.js";
import { rememberHoldOwner } from "../../../logic/board/holds.js";
import { Refused } from "../../../../../kernel/index.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { RESERVATION_ENGINE } from "../../../../../state/light.js";
import { applyItemHold } from "../../../../../items/index.js";
import { now } from "../query.js";
import { getItem } from "../query.js";
import { itemHold } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { coordinatorOnly } from "../../board.js";
import { postRigorNotices } from "../../board.js";
import { setItem } from "../../board.js";

/**
 * Hold an item through the unchanged coordinator transaction. With requireOwner true in the options, the hold also needs and
 * records its owner and deadline; absent (default), nothing about a hold changes [C7,#8539]. Why no machine setting is read
 * here: the write edge (the hold command) reads holds.requireOwner and passes the answer in the move, and the hold event
 * records it, so every replica replays the same board whatever its own setting says [C7,#8569].
 */
export function holdItem(board, id, options) {
  return applyItemHold(board, id, options, { rememberHoldOwner, coordinatorOnly, atomic, getItem, setItem, now, logEvent, postRigorNotices, itemHold, holdUntilKind, forgetHoldMaintenance, rememberHoldCondition, staleStateEngine: board.nativePorts.staleStateEngine });
}

/**
 * Record who an item is reserved for: a structured holder (a seat or block name), the actor that set it and the board own
 * clock reading; a second reservation replaces the first. Nothing reads it yet [C7,#9181]. Why the instant is the board
 * clock: every replica replays the same value. It lives beside holdItem so the status path loads no extra module [C7,#11175].
 */
export function reserveItem(board, id, { agentId, holder }) {
  coordinatorOnly(agentId, "reserves an item");
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < RESERVATION_ENGINE) {
    throw new Refused("ENGINE_VERSION", "item reservations require replay-aware writers; upgrade every linked device");
  }
  const named = String(holder ?? "").trim();
  if (!named) throw new Refused("USAGE", `a reservation names its holder: pullboard route ${id} --to <seat or block>`);
  return atomic(board, () => {
    const item = getItem(board, id);
    if (!["open", "claimed"].includes(item.item_status) || item.item_merged_commit) {
      throw new Refused("ITEM_NOT_OPEN", `item #${id} is ${item.item_status}; only open or claimed items can be reserved`);
    }
    const at = now(board);
    setItem(board, id, { item_reservation_holder: named, item_reservation_by: agentId, item_reservation_at: at });
    logEvent(board, agentId, "reserve_item", id, { holder: named });
    return { holder: named, by: agentId, at };
  });
}

/**
 * Remove an item reservation and log who cleared it and whose it was; refuse, naming the next step, when none is set [C7,#9176].
 * Why the event records the holder: the state history then shows both the reservation and its removal. It lives beside
 * reserveItem so the status path loads no extra module [C7,#11175].
 */
export function clearReservation(board, id, { agentId }) {
  coordinatorOnly(agentId, "clears an item reservation");
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < RESERVATION_ENGINE) {
    throw new Refused("ENGINE_VERSION", "clearing a reservation requires replay-aware writers; upgrade every linked device");
  }
  return atomic(board, () => {
    const held = getItem(board, id).item_reservation_holder;
    if (!held) throw new Refused("USAGE", `item #${id} holds no reservation, so there is nothing to clear; see pullboard show ${id}`);
    setItem(board, id, { item_reservation_holder: null, item_reservation_by: null, item_reservation_at: null });
    logEvent(board, agentId, "clear_reservation", id, { holder: held });
    return { holder: held };
  });
}
