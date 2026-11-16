import { engineNumber } from './engine/number.js';
const STRICT_COMPOSITION_ENGINE = engineNumber('STRICT_COMPOSITION_ENGINE');
const REVIEW_TIER_ENGINE = engineNumber('REVIEW_TIER_ENGINE');
const REVIEW_ROUTING_ENGINE = engineNumber('REVIEW_ROUTING_ENGINE');
const REVIEW_INDEPENDENCE_ENGINE = engineNumber('REVIEW_INDEPENDENCE_ENGINE');
/** Shared ordered activation witness, independent of review classification [C7,H16]. */

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

