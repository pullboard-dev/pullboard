/** Read coordinator evidence from native SQLite without replaying unrelated events [B35,R2]. */
import { coordinatorActionStats } from '../core/coordinator-actions.js';

/** Use the native clock by default and retain older merge receipts solely to deduplicate first landings. */
export function coordinatorActions(board, { since, until = board.clock.now().toISOString() } = {}) {
  since ??= new Date(Date.parse(until) - 86_400_000).toISOString();
  const history = board.db.prepare(`SELECT event_at,event_kind,event_by,item_id,event_detail FROM event
    WHERE event_kind='merged' OR (event_by='coordinator' AND event_at>=? AND event_at<=?) ORDER BY event_id`).all(since, until);
  return coordinatorActionStats(history, { since, until });
}
