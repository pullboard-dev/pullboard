/** A reject of landed sprint work queues its pull-out: one pull_out event, so the item's landing reads pulling until the revert is recorded [M2,R3,#12181]. */
import { logEvent } from './event/log.js';
import { itemPace } from './sprint-pace.js';

/** The event kinds moves' landingOf reads; merged is the fallback, the others set the landing. */
const LANDING_KINDS = Object.freeze(['merged', 'pull_out', 'pulled', 'published']);

/**
 * The pull-out a reject of `item` queues, read before the verdict moves it: its submitted commit, landed commit and builder when it is a
 * sprint item whose landing reads landed (a merged commit, and no pull_out, pulled or published since its newest merge), else null.
 * Why: the verify table's pull-out row runs only where the table models the call, and a board with no frozen verify policy keeps the
 * writer's own rules, so a reject of landed sprint work wrote no pull_out and nothing reverted it. The pace is read first, from the row
 * already loaded, so a steady or strict reject makes no board read here.
 *
 * @param {any} board
 * @param {any} item - The item row before the move.
 * @returns {{ commit: string | null, mergedCommit: string, builder: string | null } | null}
 */
export function landedSprintPullOut(board, item) {
  if (!item || itemPace(item) !== 'sprint' || !item.item_merged_commit) return null;
  const last = board.db.prepare(`SELECT event_kind kind FROM event WHERE item_id=? AND event_kind IN (${LANDING_KINDS.map(() => '?').join(',')}) ORDER BY event_id DESC LIMIT 1`)
    .get(item.item_id, ...LANDING_KINDS);
  if (last && last.kind !== 'merged') return null;
  return { commit: item.item_commit ?? null, mergedCommit: item.item_merged_commit, builder: item.item_built_by ?? item.item_owner ?? null };
}

/**
 * Write the pull_out event the verify table's pull-out row writes, with the same detail: the commit, the landed commit, the builder,
 * the verdict that pulled it out and its reason. The pull-out job reads it through pullingLanding.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ commit: string | null, mergedCommit: string, builder: string | null }} pullOut - From landedSprintPullOut.
 * @param {{ reason: string }} verdict
 */
export function queueSprintPullOut(board, id, pullOut, { reason }) {
  const verdict = board.db.prepare('SELECT MAX(verdict_id) id FROM verdict WHERE item_id=?').get(id)?.id ?? null;
  logEvent(board, 'coordinator', 'pull_out', id, { commit: pullOut.commit, mergedCommit: pullOut.mergedCommit, builder: pullOut.builder, verdict, reason });
}
