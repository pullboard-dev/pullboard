/** Whether a board's engine routes reviews, read by seat capacity and the verify cell above it [C7,V1,B3]. */
import { ENGINE_VERSION } from './engine-metadata.js';
import { REVIEW_ROUTING_ENGINE } from './review-routing-engine.js';

/** Historical recorded reservations retain the ordering and eligibility they originally used. */
export function reviewRoutingEnabled(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_ROUTING_ENGINE;
}
