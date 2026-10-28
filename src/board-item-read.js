import { ENGINE_VERSION } from './engine-metadata.js';
import { REJECTED_WORK_RETURN_ENGINE } from './rejected-work-return-engine.js';
/** Pure per-item reads without loading the query facade [C7,H16,B13]. */
import { Refused } from './refused.js';
/**
 * The item with this id, or a refusal naming the id.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any}
 */
export function itemById(board, id) {
  const redirect = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_redirect:${id}`);
  if (redirect) {
    const target = JSON.parse(redirect.meta_value);
    throw new Refused('NO_ITEM', `item #${id} moved to ${target.destinationHandle ?? target.destinationBoardId}#${target.destinationItemId}; use that destination reference`);
  }
  const item = board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
  if (!item) throw new Refused('NO_ITEM', `no item #${id}; see: pullboard list`);
  return item;
}

/** Read the latest return's window, ignoring review releases and earlier submissions. */
export function firstRefusal(board, id, at = board.clock.now()) {
  const history = board.db.prepare("SELECT event_id, event_kind, event_detail, event_by FROM event WHERE item_id = ? AND event_kind IN ('reject', 'reopen', 'submit', 'release', 'reject_returned') ORDER BY event_id DESC").all(id);
  const releases = [];
  const returned = new Set();
  for (const event of history) {
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'reject_returned') {
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= REJECTED_WORK_RETURN_ENGINE && detail.engine >= REJECTED_WORK_RETURN_ENGINE) returned.add(detail.rejection);
      continue;
    }
    if (event.event_kind === 'release') { releases.push(event); continue; }
    if (event.event_kind === 'submit') return null;
    if (event.event_kind === 'reject' && returned.has(event.event_id)) return null;
    const window = detail.reopenFirstRefusal;
    if (!window || !window.builder || !Number.isFinite(Date.parse(window.until))) return null;
    if (releases.some(release => release.event_by === window.builder && JSON.parse(release.event_detail).review !== true)) return null;
    return at.getTime() < Date.parse(window.until) ? window : null;
  }
  return null;
}
