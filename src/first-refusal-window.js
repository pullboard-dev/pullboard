import { REJECTED_WORK_RETURN_ENGINE } from './rejected-work-return-engine.js';
import { ENGINE_VERSION } from './machine.js';
/** Pure recorded first-refusal reader shared by move declarations [B13,H16,C7]. */
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

