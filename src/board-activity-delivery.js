import * as activityDeliveryStore from './activity-delivery-store.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';

/** Read recipient delivery state without mutating any cursor or receipt. */
export function activityDeliveryState(board, agentId) {
  return activityDeliveryStore.activityDeliveryState(board, agentId);
}

/** Record the exact interrupts included in an authenticated recipient response. */
export function recordActivityDelivery(board, options) {
  return activityDeliveryStore.recordActivityDelivery(board, options, { atomic, logEvent });
}
