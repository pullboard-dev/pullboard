import { REJECT_OPEN_ENGINE } from '../../../../../state/light.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../../state/light.js';
import { LEASE_LAPSE_ENGINE } from "../../../../../state/light.js";
import { CHECK_TIMING_ENGINE } from "../../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../../state/light.js";
import { REJECTED_WORK_RETURN_ENGINE } from "../../../../../state/light.js";
/** Pure per-item reads without loading the query facade [C7,H16,B13]. */
import { Refused } from "../../../../../kernel/light.js";
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
  const row = board.db.prepare("SELECT item.*, timing.meta_value AS check_timing, expected.meta_value AS expected_build FROM item LEFT JOIN board_meta timing ON timing.meta_key='item_check_timing:' || item.item_id LEFT JOIN board_meta expected ON expected.meta_key='item_expected_build_minutes:' || item.item_id WHERE item_id = ?").get(id);
  if (!row) throw new Refused('NO_ITEM', `no item #${id}; see: pullboard list`);
  const { check_timing, expected_build, ...stored } = row;
  const item = (board.executionEngineVersion ?? ENGINE_VERSION) >= EXPECTED_BUILD_ENGINE && expected_build !== null
    ? { ...stored, item_expected_build_minutes: JSON.parse(expected_build) } : stored;
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= CHECK_TIMING_ENGINE && check_timing !== null
    ? { ...item, item_check_timing: JSON.parse(check_timing) } : item;
}

/** Read the latest return's window, ignoring review releases and earlier submissions. */
export function firstRefusal(board, id, at = board.clock.now()) {
  const kinds = (board.executionEngineVersion ?? ENGINE_VERSION) >= board.enginePorts.submitHandoffEngines().handoff
    ? "'reject', 'reopen', 'submit', 'release', 'reject_returned', 'submit_handoff_returned'"
    : "'reject', 'reopen', 'submit', 'release', 'reject_returned'";
  const history = board.db.prepare(`SELECT event_id, event_kind, event_detail, event_by FROM event WHERE item_id = ? AND event_kind IN (${kinds}) ORDER BY event_id DESC`).all(id);
  const releases = [];
  const returned = new Set();
  for (const event of history) {
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'reject_returned') {
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= REJECTED_WORK_RETURN_ENGINE && detail.engine >= REJECTED_WORK_RETURN_ENGINE) returned.add(detail.rejection);
      continue;
    }
    if (event.event_kind === 'release' && !detail.reopenFirstRefusal?.otherSeatFirst && !((board.executionEngineVersion ?? ENGINE_VERSION) >= LEASE_LAPSE_ENGINE && detail.expiredClaim)) { releases.push(event); continue; }
    if (event.event_kind === 'submit') return null;
    // From REJECT_OPEN_ENGINE a rejection reserves nothing, so a window sealed by an older engine is ignored after an upgrade (#2779).
    if (event.event_kind === 'reject' && (returned.has(event.event_id)
      || (board.executionEngineVersion ?? ENGINE_VERSION) >= REJECT_OPEN_ENGINE)) return null;
    const window = detail.reopenFirstRefusal;
    if (!window || !window.builder || !Number.isFinite(Date.parse(window.until))) return null;
    if (releases.some(release => release.event_by === window.builder && JSON.parse(release.event_detail).review !== true)) return null;
    return at.getTime() < Date.parse(window.until) ? window : null;
  }
  return null;
}
