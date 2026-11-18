import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../state/light.js';

/** A frozen threshold fences every newly ordered selection or reservation that may use it [H16]. */
export function frozenRelaxationEngine(board, itemId) {
  if (!board?.db) return 1;
  const rows = itemId === undefined
    ? board.db.prepare("SELECT item_frozen FROM item WHERE item_status='submitted'").all()
    : [board.db.prepare('SELECT item_frozen FROM item WHERE item_id=?').get(itemId)].filter(Boolean);
  return rows.some(row => {
    try {
      const value = JSON.parse(row.item_frozen ?? '{}')?.policy?.verify?.familyRelaxAt;
      return Number.isSafeInteger(value) && value > 0;
    } catch { return false; }
  }) ? REVIEW_FAMILY_RELAX_ENGINE : 1;
}

/** The engine floor is the largest engine number of every trigger whose condition holds, and 1 when none does; each pair is [engineNumber, condition] [H16]. */
export function floorMax(...pairs) {
  return Math.max(1, ...pairs.filter(([, condition]) => condition).map(([engine]) => engine));
}
