/** Normalize implicit strict tiers once, in the native write transaction [#1949]. */
import { REVIEW_DEFAULT_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { gateJudgmentItem } from './tier.js';
import { itemReviewPolicy } from '../../logic/review/policy.js';

/** Existing snapshots change only on a successful modern write; failed writes roll back this witness too. */
export function normalizeReviewDefaults(board, { logEvent, itemId }) {
  if (!Number.isSafeInteger(itemId)) return;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_DEFAULT_ENGINE) return;
  if (!board.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item'").get()
    || !board.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='board_meta'").get()) return;
  const active = board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get();
  const item = board.db.prepare('SELECT item_id, item_status FROM item WHERE item_id=?').get(itemId);
  if (!item || board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`review_default:normalized:${itemId}`)) return;
  const insert = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)');
  const changed = [];
  const id = item.item_id;
  const policy = itemReviewPolicy(board, id);
  const implicitStrict = !policy.sensitive && !policy.reviewFamily && policy.reviewTier !== 'strict' && gateJudgmentItem(board, id);
  // The active marker is global, but this bounded entry point sees only one write at a time. After the first write
  // activates defaults, an unmarked judgment item still needs the same pre-activation strict projection.
  if (implicitStrict && (policy.tier === 'strict' || active)) {
    insert.run(`review_default:normalized:${id}`, JSON.stringify({ item: id, at: board.clock.now().toISOString(),
      from: 'strict', to: 'standard', reason: 'no explicit sensitive or review-family mark' }));
    changed.push({ id });
  }
  if (!active) insert.run('review_default:active', String(REVIEW_DEFAULT_ENGINE));
  if (!changed.length) return;
  const unfinished = changed.filter(({ id }) => {
    const status = board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id)?.item_status;
    return status !== undefined && !['verified', 'withdrawn'].includes(status);
  }).map(({ id }) => id);
  logEvent(board, 'board', 'review-default', null, { engine: REVIEW_DEFAULT_ENGINE, count: changed.length, unfinished });
  board.reviewDefaultNotice = [
    `${changed.length} items moved to standard review.`,
    ...unfinished.map(id => `#${id} review normalized from strict to standard: no explicit sensitive or review-family mark.`),
  ];
}
