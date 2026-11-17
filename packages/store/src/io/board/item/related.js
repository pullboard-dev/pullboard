/** Optional free links between items: related, never a dependency, behind items.typedFields (#9355, #1321) [C7]. */
import { atomic } from '../event/log.js';
import { Refused } from '../../../../../kernel/index.js';

/**
 * The link table, made on first use instead of in the board schema.
 * Why: with the setting off no board gains a table, so the schema digest and every existing reader stay as they were.
 * Why one ordered pair: relating 12 to 14 and 14 to 12 is the same link, so a link is stored once as (low, high).
 */
export const RELATED_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS item_related (
    item_low INTEGER NOT NULL REFERENCES item (item_id),
    item_high INTEGER NOT NULL REFERENCES item (item_id),
    related_by TEXT NOT NULL,
    related_at TEXT NOT NULL,
    PRIMARY KEY (item_low, item_high),
    CHECK (item_low < item_high)
  );
`;

/** True when the link table exists on this board. */
function hasTable(db) {
  return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='item_related'").get().n === 1;
}

/**
 * Relate two items. The link is symmetric, stored once, and never touches either item's `after` list, so it blocks nothing.
 * Relating a pair twice stores one link. An unknown item is refused NO_SUCH_ITEM and nothing is stored.
 *
 * @param {{ db: any }} board
 * @param {{ by: string, a: number, b: number, enabled?: boolean }} call - `enabled` is items.typedFields, read by the caller.
 * @returns {{ low: number, high: number, created: boolean }}
 */
export function relateItems(board, { by, a, b, enabled = false }) {
  if (enabled !== true) throw new Refused('RELATED_OFF', 'related links are off; turn on items.typedFields in the machine settings first');
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Refused('USAGE', 'relate takes two item ids; try: pullboard relate 12 14');
  if (a === b) throw new Refused('RELATED_SELF', `item #${a} cannot be related to itself; give two different ids`);
  return atomic(board, () => {
    for (const id of [a, b]) {
      if (!board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(id)) throw new Refused('NO_SUCH_ITEM', `item #${id} does not exist; check the id with: pullboard list`);
    }
    board.db.exec(RELATED_SCHEMA_SQL);
    const [low, high] = a < b ? [a, b] : [b, a];
    const result = board.db.prepare('INSERT OR IGNORE INTO item_related (item_low, item_high, related_by, related_at) VALUES (?,?,?,?)')
      .run(low, high, by, new Date().toISOString());
    return { low, high, created: result.changes === 1 };
  });
}

/**
 * The ids related to an item, ascending. Empty when the setting is off or the table was never made, so a reader needs no guard.
 *
 * @param {{ db: any }} board
 * @param {number} id
 * @param {{ enabled?: boolean }} [options]
 * @returns {number[]}
 */
export function relatedLinks(board, id, { enabled = false } = {}) {
  if (enabled !== true || !hasTable(board.db)) return [];
  return board.db.prepare('SELECT item_high AS other FROM item_related WHERE item_low=? UNION SELECT item_low AS other FROM item_related WHERE item_high=? ORDER BY other')
    .all(id, id).map(row => row.other);
}
