/** Normalize implicit strict tiers once, in the native write transaction [#1949]. */
import { REVIEW_DEFAULT_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { gateJudgmentItem } from './tier.js';
import { itemReviewPolicy } from '../../logic/review/policy.js';

/** Existing snapshots change only on a successful modern write; failed writes roll back this witness too. */
export function normalizeReviewDefaults(board, { logEvent }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_DEFAULT_ENGINE) return;
  if (!board.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item'").get()
    || !board.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='board_meta'").get()) return;
  if (board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get()) return;
  const items = board.db.prepare('SELECT item_id, item_status FROM item ORDER BY item_id').all();
  if (!items.length) return;
  const insert = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)');
  const changed = [];
  for (const item of items) {
    const id = item.item_id;
    const policy = itemReviewPolicy(board, id);
    if (policy.tier === 'strict' && !policy.sensitive && !policy.reviewFamily && policy.reviewTier !== 'strict' && gateJudgmentItem(board, id)) {
      insert.run(`review_default:normalized:${id}`, JSON.stringify({ item: id, at: board.clock.now().toISOString(),
        from: 'strict', to: 'standard', reason: 'no explicit sensitive or review-family mark' }));
      changed.push({ id, status: item.item_status });
    }
  }
  insert.run('review_default:active', String(REVIEW_DEFAULT_ENGINE));
  if (!changed.length) return;
  const unfinished = changed.filter(({ status }) => !['verified', 'withdrawn'].includes(status)).map(({ id }) => id);
  logEvent(board, 'board', 'review-default', null, { engine: REVIEW_DEFAULT_ENGINE, count: changed.length, unfinished });
  board.reviewDefaultNotice = [
    `${changed.length} items moved to standard review.`,
    ...unfinished.map(id => `#${id} review normalized from strict to standard: no explicit sensitive or review-family mark.`),
  ];
}
