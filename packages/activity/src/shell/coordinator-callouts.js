/** Read the open coordinator call-outs from the board's shout rows [N2,C7]. */
import { calloutLine } from '../core/coordinator-callouts.js';
import { openCallouts } from '../core/coordinator-callouts.js';
import { SUBJECT_CHANGE_KINDS } from '../core/coordinator-callouts.js';

const COORDINATOR = 'coordinator';

/**
 * The call-out line for `pullboard next`, or null. Computed from shout rows: shouts to the coordinator that nobody
 * answered and whose named item has not changed since.
 *
 * @param {any} board
 * @param {number} nowMs
 * @returns {string | null}
 */
export function coordinatorCalloutLine(board, nowMs) {
  const rows = board.db.prepare("SELECT shout_id, shout_at, shout_text FROM shout WHERE shout_to = ? AND shout_from != ? AND shout_answers IS NULL ORDER BY shout_id").all(COORDINATOR, COORDINATOR);
  if (!rows.length) return null;
  const answered = new Set(board.db.prepare('SELECT shout_answers AS id FROM shout WHERE shout_answers IS NOT NULL').all().map(row => row.id));
  const marks = SUBJECT_CHANGE_KINDS.map(() => '?').join(',');
  const changed = board.db.prepare(`SELECT 1 FROM event WHERE item_id = ? AND event_at > ? AND event_kind IN (${marks}) LIMIT 1`);
  const open = openCallouts(rows.map(row => ({ id: row.shout_id, at: row.shout_at, text: row.shout_text })), answered,
    (item, since) => changed.get(item, since, ...SUBJECT_CHANGE_KINDS) !== undefined);
  const seat = board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ? LIMIT 1').get(COORDINATOR) !== undefined;
  return calloutLine(open, nowMs, seat);
}
