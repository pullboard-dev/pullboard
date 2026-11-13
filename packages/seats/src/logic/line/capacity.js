/** Board-owned capacity uses recorded review work, never a seat's lane as its permanent role [N2,B13,H16]. */
import { LINE_CAPACITY_ENGINE } from '../../../../state/light.js';
import { lineSettings } from '../../../../state/light.js';
import { flowWindowBounds } from '../bounds.js';
import { Refused } from '../../../../kernel/browser.js';
import {
  ACTIVE_REVIEWER_WINDOW_MINUTES,
  lineWipLimit,
} from './limit.js';

/** Old ordered claims keep their original semantics even beside newer recorded controls. */
export function capacitySettings(board) {
  return (board.executionEngineVersion ?? Infinity) >= LINE_CAPACITY_ENGINE ? lineSettings(board) : {};
}

/** The controller and capacity count use the same validated flow-window boundaries; the default is one hour. */
export function lineCapacitySnapshot(board, { windowMinutes = ACTIVE_REVIEWER_WINDOW_MINUTES } = {}) {
  const at = board.clock.now().getTime();
  const window = flowWindowBounds(windowMinutes, at);
  const reviewers = board.db.prepare(`SELECT DISTINCT event_by FROM event JOIN agent ON agent_id=event_by
    WHERE event_kind IN ('reserve','accept','reject','verify') AND event_at>=? AND event_at<=?`).all(window.since, window.until);
  const pending = board.db.prepare(`SELECT item.*, MAX(event.event_id) AS submitted_order FROM item
    LEFT JOIN event ON event.item_id=item.item_id AND event_kind='submit' WHERE item_status='submitted'
    GROUP BY item.item_id ORDER BY submitted_order, item.item_id`).all();
  const building = board.db.prepare("SELECT COUNT(*) AS count FROM item WHERE item_status='claimed' AND item_lease_until>?").get(window.until).count;
  return { ...window, activeReviewers: Math.max(reviewers.length, 1), pending, building, wip: pending.length + building };
}

/** Enforce only a new claim; renewals cannot be stranded by a setting changed during their existing work. */
export function lineCapacityProblem(board, { renewal, oldestReview } = {}) {
  const ratio = capacitySettings(board).wipPerReviewer;
  if (renewal || typeof ratio !== 'number') return null;
  const snapshot = lineCapacitySnapshot(board);
  const limit = lineWipLimit(ratio, snapshot.activeReviewers);
  if (snapshot.wip + 1 <= limit) return null;
  const review = oldestReview?.(snapshot.pending);
  const age = review?.submitted_order === null ? 'waiting item (submit age unknown)' : 'oldest waiting item';
  return new Refused('LINE_WIP_LIMIT', `the line has ${snapshot.wip} live claims and submissions against limit ${limit}; `
    + (review ? `review ${age} #${review.item_id}: pullboard next --verify ${review.item_id}`
      : 'no waiting review is eligible for this seat; ask the coordinator to arrange an eligible reviewer'));
}

/** A recorded idle wait may shorten a send-back's builder reservation, but never steals a live claim. */
export function takeoverReady(board, id) {
  const minutes = capacitySettings(board).takeoverMinutes;
  if (typeof minutes !== 'number') return false;
  const item = board.db.prepare('SELECT item_status, item_lease_until FROM item WHERE item_id=?').get(id);
  const now = board.clock.now().getTime();
  if (item?.item_status === 'claimed' && Date.parse(item.item_lease_until) > now) return false;
  const returned = board.db.prepare("SELECT event_id, event_at, event_kind FROM event WHERE item_id=? AND event_kind IN ('reject','reopen','submit') ORDER BY event_id DESC LIMIT 1").get(id);
  if (!returned || returned.event_kind === 'submit') return false;
  const activity = board.db.prepare("SELECT event_at FROM event WHERE item_id=? AND event_id>? AND event_kind IN ('claim','renew','release') ORDER BY event_id DESC LIMIT 1").get(id, returned.event_id);
  const since = Date.parse(activity?.event_at ?? returned.event_at);
  return Number.isFinite(since) && now >= since + minutes * 60_000;
}

/** A session that left no activity this long, with no live process, is gone: the same thirty minutes the seat presence projection uses. */
export const SEAT_SESSION_STALE_MS = 30 * 60_000;

/**
 * Whether a seat's session has ended: its session process is known not to be running and it has done nothing for the
 * stale interval. Why both: a quiet seat with a live session is merely idle, and a seat whose process state is unknown
 * (`sessionLive` undefined) is never called gone from silence alone, so a hook-less seat keeps its place in the idle share.
 *
 * @param {{ sessionLive?: boolean, lastActivityAt: number, now: number, staleMs?: number }} seat - Times in epoch milliseconds.
 * @returns {boolean}
 */
export function seatSessionGone({ sessionLive, lastActivityAt, now, staleMs = SEAT_SESSION_STALE_MS }) {
  return sessionLive === false && Number.isFinite(lastActivityAt) && now - lastActivityAt >= staleMs;
}
