/** With slices.enforcePaths on, a slice's submit may only change the paths its slice declared [C7,B26]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { pathsOutsideSlice } from '../../logic/slice-paths.js';
import { siblingOwning } from '../../logic/slice-paths.js';

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
  const sibling = siblingOwning(outside[0], siblingSlices(board, item, parentOf(row)));
  const owner = sibling ? ` (declared by sibling slice #${sibling.id}, held by ${sibling.owner || 'nobody yet'})` : '';
  throw new Refused('SLICE_PATHS', `slice #${item.item_id} changes ${outside.length} path(s) outside its declared set, e.g. ${outside[0]}${owner}`,
    `revert ${outside[0]}, or ask the parent's holder for a slice that declares it; the check is the slices.enforcePaths setting`);
}

/** The parent id recorded on a slice's board_meta row, or null when unreadable. */
function parentOf(row) {
  try { return JSON.parse(row.meta_value).parentId ?? null; } catch { return null; }
}

/** Other slices of the same parent with their declared files and current holder; empty when the board cannot list them. */
function siblingSlices(board, item, parentId) {
  if (parentId === null) return [];
  const rows = board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'item-slice:%'").all?.() ?? [];
  const found = [];
  for (const row of rows) {
    const id = Number(row.meta_key.slice('item-slice:'.length));
    if (id === item.item_id) continue;
    let detail;
    try { detail = JSON.parse(row.meta_value); } catch { continue; }
    if (detail.parentId !== parentId || !Array.isArray(detail.files)) continue;
    const held = board.db.prepare('SELECT item_owner FROM item WHERE item_id=?').get(id);
    found.push({ id, files: detail.files, owner: held?.item_owner ?? null });
  }
  return found;
}
