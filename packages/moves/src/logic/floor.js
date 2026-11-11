import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../state/light.js';

/** A frozen threshold fences every newly ordered selection or reservation that may use it [H16]. */
export function frozenRelaxationEngine(board, itemId) {
  if (!board?.db) return 1;
  const rows = itemId === undefined
    ? board.db.prepare("SELECT item_frozen, item_verify_policy FROM item WHERE item_status='submitted'").all()
    : [board.db.prepare('SELECT item_frozen, item_verify_policy FROM item WHERE item_id=?').get(itemId)].filter(Boolean);
  return rows.some(row => {
    try {
      // A previous-release freeze pins the threshold; a bar-only freeze takes the one its submit pinned [B4,R2].
      const legacy = JSON.parse(row.item_frozen ?? '{}')?.policy;
      const value = (legacy ? legacy.verify : JSON.parse(row.item_verify_policy ?? 'null')?.verify)?.familyRelaxAt;
      return Number.isSafeInteger(value) && value > 0;
    } catch { return false; }
  }) ? REVIEW_FAMILY_RELAX_ENGINE : 1;
}
