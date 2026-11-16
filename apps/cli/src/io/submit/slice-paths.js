/** With slices.enforcePaths on, a slice's submit may only change the paths its slice declared [C7,B26]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { pathsOutsideSlice } from '../../logic/slice-paths.js';

/**
 * Refuse a submit of a slice item whose net change touches a path outside its declared set.
 * Why: a slice is a bounded piece of its parent; touching other files means the cut was wrong. Off by default.
 */
export function requireSlicePaths(board, item, changed, enabled) {
  if (enabled !== true) return;
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item-slice:${item.item_id}`);
  if (!row) return;
  let declared;
  try { declared = JSON.parse(row.meta_value).files; } catch { return; }
  if (!Array.isArray(declared)) return;
  const outside = pathsOutsideSlice(changed, declared);
  if (!outside.length) return;
  throw new Refused('SLICE_PATHS', `slice #${item.item_id} changes ${outside.length} path(s) outside its declared set, e.g. ${outside[0]}`,
    `revert ${outside[0]}, or ask the parent's holder for a slice that declares it; the check is the slices.enforcePaths setting`);
}
