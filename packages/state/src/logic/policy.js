import { STRICT_COMPOSITION_ENGINE } from './engines/strict-composition-engine.js';
/** Shared ordered activation witness, independent of review classification [C7,H16]. */
import { REVIEW_TIER_ENGINE } from './engines/review-tier-engine.js';
import { REVIEW_ROUTING_ENGINE } from './engines/review-routing-engine.js';
import { REVIEW_INDEPENDENCE_ENGINE } from './engines/review-independence-engine.js';

/** The first modern native prefix position activates new review rules without rewriting older receipts. */
export function recordReviewPolicyActivation(board, engine) {
  if (engine >= STRICT_COMPOSITION_ENGINE) {
    board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES('review_composition:active',?) ON CONFLICT(meta_key) DO NOTHING")
      .run(String(STRICT_COMPOSITION_ENGINE));
  }
  if (engine >= REVIEW_TIER_ENGINE) {
    board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES('review_tier:active',?) ON CONFLICT(meta_key) DO NOTHING")
      .run(String(REVIEW_TIER_ENGINE));
  }
  if (engine >= REVIEW_ROUTING_ENGINE) {
    board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES('review_routing:active',?) ON CONFLICT(meta_key) DO NOTHING")
      .run(String(REVIEW_ROUTING_ENGINE));
  }
  if (engine < REVIEW_INDEPENDENCE_ENGINE) return;
  board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES('review_independence:active',?) ON CONFLICT(meta_key) DO NOTHING")
    .run(String(REVIEW_INDEPENDENCE_ENGINE));
}

