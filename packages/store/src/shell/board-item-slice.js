/** Create one ordinary child bound to its parent's frozen bar [C7,B26,H16]. */
import { atomic, logEvent } from './board-event-log.js';
import { hasAgent, itemById } from './board-query.js';
import { insertItem, validateItemAddition } from './board-add-item.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { ITEM_SLICE_ENGINE } from '../../../../src/item-slice-engine.js';
import { Refused } from '../../../kernel/index.js';

/** Serialize authorization, frozen-parent validation, child creation and provenance. */
export function createItemSlice(board, { agentId, parentId, parentDigest, title, lane, files, check }) {
  return atomic(board, () => {
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_SLICE_ENGINE) throw new Refused('ENGINE_VERSION', `slices require engine ${ITEM_SLICE_ENGINE}; upgrade Pullboard`);
    if (!hasAgent(board, agentId)) throw new Refused('NOT_JOINED', 'join before creating a slice');
    const parent = itemById(board, parentId);
    if (parent.item_status !== 'claimed' || (agentId !== 'coordinator' && parent.item_owner !== agentId)) throw new Refused('SLICE_OWNER', 'only the holder of a claimed parent or the coordinator may create a slice');
    if (!parent.item_frozen || !parent.item_frozen_digest || parentDigest !== parent.item_frozen_digest) throw new Refused('SLICE_BAR_MOVED', 'read the current frozen parent bar before creating a slice');
    let frozen;
    try { frozen = JSON.parse(parent.item_frozen); } catch { throw new Refused('SLICE_BAR_MOVED', 'the frozen parent bar is unreadable'); }
    if (typeof frozen.criterion !== 'string' || !Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !file || file.startsWith('/') || /[\\\r\n\0]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) || new Set(files).size !== files.length) throw new Refused('SLICE_FILES', 'supply distinct repository-relative files for the slice');
    const item = { by: agentId, parentId, lane: lane ?? parent.item_lane, title, criterion: frozen.criterion,
      specIds: String(parent.item_spec_ids ?? '').split(',').filter(Boolean), after: [], brief: `Files: ${files.join(', ')}\nSlice of #${parentId}; parent bar ${parentDigest}`, route: parent.item_route, check: check ?? frozen.check ?? '' };
    // The slice move grants the holder this scoped check choice; it does not grant ordinary bar editing.
    const validated = validateItemAddition(board, { ...item, by: 'coordinator', parentId: null });
    const id = insertItem(board, item, validated);
    const detail = { parentId, parentDigest, files, lane: item.lane };
    board.db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES (?, ?)').run(`item-slice:${id}`, JSON.stringify(detail));
    logEvent(board, agentId, 'item-slice', id, detail);
    return { item: id };
  });
}
