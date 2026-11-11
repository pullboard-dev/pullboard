/** Item status and verdict totals for board summaries. */
import { NEXT_IDLE_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/light.js";
import { stageCounts } from "../item/stage.js";
import { stuckReturns } from "../rework.js";

/**
 * Counts for the status line and the ledger's summary: items by status, verdicts by decision.
 *
 * @param {any} board
 * @returns {{ items: Record<string, number>, stages: Record<string, number>, accepted: number, rejected: number }}
 */
export function stats(board) {
  const items = { open: 0, claimed: 0, submitted: 0, verified: 0, withdrawn: 0 };
  const counts = board.db.prepare(`SELECT CASE WHEN item_status='claimed' AND COALESCE(item_lease_until,'')<=?
    THEN 'open' ELSE item_status END AS status, COUNT(*) AS total FROM item GROUP BY status`).all(board.clock.now().toISOString());
  for (const row of counts) items[row.status] = row.total;
  const verdicts = board.db
    .prepare('SELECT verdict_decision AS decision, COUNT(*) AS total FROM verdict GROUP BY verdict_decision')
    .all();
  const count = (decision) => verdicts.find((row) => row.decision === decision)?.total ?? 0;
  return { items, stages: stageCounts(board), accepted: count('ACCEPT'), rejected: count('REJECT') };
}

/** Record the authenticated seat's actual empty-next observation, never eligibility or claim authority [R2,N2]. */
export function recordNextIdle(board, { agentId, reason, skips = [] }, { atomic, logEvent, agentById, shoutStuck }) {
  return atomic(board, () => {
    if (!agentById(board, agentId)) throw new Refused('NOT_JOINED', 'join a lane before recording next idle');
    if (!['nothing-eligible', 'held', 'review-family', 'main-red', 'focus', 'unknown'].includes(reason)) {
      throw new Refused('BAD_IDLE_REASON', 'record the structured reason returned by next, not guessed historical eligibility');
    }
    if (!Array.isArray(skips) || skips.length > 3 || skips.some(row => !Number.isSafeInteger(row?.item) || row.item <= 0 || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(row.code))
      || new Set(skips.map(row => row.item)).size !== skips.length) throw new Refused('BAD_IDLE_SKIPS', 'record up to three distinct candidate ids and their first native skip codes');
    const unchanged = nextIdleUnchanged(board, { agentId, reason, skips });
    if (unchanged) return unchanged;
    logEvent(board, agentId, 'next-idle', null, { version: 1, engine: NEXT_IDLE_ENGINE, reason, ...(skips.length ? { skips } : {}) });
    shoutStuck?.(board, agentId);
    return { recorded: true };
  });
}

/** Read whether the persisted idle interval already describes this seat, without taking a writer. */
function nextIdleUnchanged(board, { agentId, reason, skips = [] }) {
  const now = board.clock.now().toISOString();
  const working = board.db.prepare(`SELECT 1 FROM item WHERE
    (item_status='claimed' AND item_owner=? AND item_lease_until>?) OR
    (item_status='submitted' AND item_review_by=? AND item_review_until>?) LIMIT 1`).get(agentId, now, agentId, now);
  if (working) return { recorded: false, reason: 'seat-working' };
  // Returned work open over 1 h owes the coordinator a shout, so this idle call takes the writer (#5765).
  if (stuckReturns(board, board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(agentId)?.agent_lane).length) return null;
  const latest = board.db.prepare('SELECT event_kind,event_detail FROM event WHERE event_by=? ORDER BY event_id DESC LIMIT 1').get(agentId);
  if (latest?.event_kind === 'next-idle') {
    const detail = JSON.parse(latest.event_detail);
    if (detail.version === 1 && detail.engine === NEXT_IDLE_ENGINE && detail.reason === reason && JSON.stringify(detail.skips ?? []) === JSON.stringify(skips)) return { recorded: true, unchanged: true };
  }
  return null;
}

/** Open an idle writer only for a real observation change; the ordered move rechecks it. */
export function nextIdleChanged(board, options) {
  return nextIdleUnchanged(board, options) === null;
}
