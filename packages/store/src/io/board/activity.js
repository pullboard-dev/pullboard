import * as activityDeliveryStore from "../../logic/board/activity/delivery.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";

/** Record an explicit recipient acknowledgement separately from delivery. */
export function actOnActivity(board, options) {
  return activityDeliveryStore.actOnActivity(board, options, { atomic, logEvent });
}
