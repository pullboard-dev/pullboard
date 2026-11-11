import * as activityDeliveryStore from "../../logic/board/activity/delivery.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";

/** Read recipient delivery state without mutating any cursor or receipt. */
export function activityDeliveryState(board, agentId) {
  return activityDeliveryStore.activityDeliveryState(board, agentId);
}

/** Read whether one exact interrupt was already delivered or acted on without exposing its storage key [R2,N26,H16]. */
export function activityInterruptWasDelivered(board, agentId, id) {
  return activityDeliveryStore.activityInterruptWasDelivered(board, agentId, id);
}

/** Record the exact interrupts included in an authenticated recipient response. */
export function recordActivityDelivery(board, options) {
  return activityDeliveryStore.recordActivityDelivery(board, options, { atomic, logEvent });
}
