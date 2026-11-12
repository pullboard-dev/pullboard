/** Read recorded release membership without loading the Git-aware health path [B4,C7]. */
import { milestones } from '../../../../../store/light.js';

/** Current release members block its shipment; use recorded membership and actual landed state, never title text. */
export function releaseBlockingItems(board) {
  const releases = milestones(board).filter(entry => !entry.shipped);
  for (const release of releases) {
    const ids = release.items.filter(id => Number.isSafeInteger(id));
    const pending = ids.filter(id => {
      const item = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?').get(id);
      return item && item.item_status !== 'withdrawn' && !(item.item_status === 'verified' && item.item_merged_commit);
    });
    if (pending.length) return new Set(pending);
  }
  return new Set();
}

