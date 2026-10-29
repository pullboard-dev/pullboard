import * as activityDeliveryStore from './board-activity-delivery-store.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';

/** Record an explicit recipient acknowledgement separately from delivery. */
export function actOnActivity(board, options) {
  return activityDeliveryStore.actOnActivity(board, options, { atomic, logEvent });
}
