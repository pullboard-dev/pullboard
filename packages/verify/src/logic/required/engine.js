/** The reviewer-family reads a move declaration's engine floor needs, with no seat-family writer behind them [C7,V1,V2,H16]. */
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../../state/light.js';

/** Read the canonical optional metadata without changing the board. */
export function requiredReviewFamily(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_review_family:${id}`)?.meta_value;
}

/** New moves touching a constrained item need the engine that preserves that constraint. */
export function requiredReviewFamilyEngine(board, id) {
  return board && requiredReviewFamily(board, id) ? AUTOMATIC_DISPATCH_ENGINE : 1;
}

/** Any queued selection must understand item requirements before choosing among boards' items. */
export function anyRequiredReviewFamilyEngine(board) {
  return board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key LIKE 'item_review_family:%' LIMIT 1").get()
    ? AUTOMATIC_DISPATCH_ENGINE : 1;
}
