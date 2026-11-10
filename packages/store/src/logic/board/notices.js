/** Immutable recipient-bound notices arise in the landing transaction, without a coordinator move [B35,R2]. */
import { progressWaits } from '../../../../roadmap/index.js';

/** Notify the current or last claimant once all native dependencies land; source event identity deduplicates replay. */
export function notifyUnblocked(board, source, append) {
  const items = board.db.prepare('SELECT * FROM item ORDER BY item_id').all();
  const byId = new Map(items.map(item => [item.item_id, item]));
  for (const item of items) {
    const dependencies = String(item.item_after ?? '').split(',').filter(Boolean);
    const affected = dependencies.includes(String(source.item_id)) || source.event_kind === 'unhold_item' && item.item_id === source.item_id
      || source.event_kind === 'unhold' && item.item_lane === JSON.parse(source.event_detail).lane;
    if (!affected || item.item_merged_commit || item.item_status === 'withdrawn' || progressWaits(item, byId).length
      || board.db.prepare('SELECT 1 FROM hold WHERE hold_lane=?').get(item.item_lane)) continue;
    const state = dependencies.map(id => `${id}:${byId.get(Number(id))?.item_merged_commit ?? byId.get(Number(id))?.item_status}`).join(',');
    const episode = ['unhold_item', 'unhold'].includes(source.event_kind) ? `:${source.event_id}` : '';
    const key = `progress:unblocked:${item.item_id}:${state}${episode}`;
    if (board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(key)) continue;
    const holder = item.item_owner ?? board.db.prepare("SELECT event_by FROM event WHERE item_id=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(item.item_id)?.event_by;
    if (!holder) continue;
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(key, String(source.event_id));
    append(board, 'board', 'work_notice', item.item_id, { kind: 'unblocked', holder, sourceEventId: source.event_id });
  }
}
