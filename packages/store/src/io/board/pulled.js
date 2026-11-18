/** The pulled writer: the lander's pushed revert ends an item's pull-out through the landing-pulled table [M2,R3,#9098]. */
import { atomic } from './event/log.js';
import { logEvent } from './event/log.js';
import { Refused } from '../../../../kernel/index.js';
import { runPulledTable } from '../../logic/board/landing/lease.js';

/** The event kinds landingOf reads, oldest first: pull_out, pulled and published set the landing, merged is the fallback. */
const LANDING_KINDS = Object.freeze(['merged', 'pull_out', 'pulled', 'published']);

/** An event's detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

/** The item row and its landing events, oldest first, as PULLED_TABLE reads them; a missing item has no history. */
function landingSnapshot(board, id) {
  const row = board.db.prepare('SELECT item_id, item_status, item_merged_commit FROM item WHERE item_id=?').get(id);
  const history = row ? board.db.prepare(`SELECT event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN (${LANDING_KINDS.map(() => '?').join(',')}) ORDER BY event_id`)
    .all(id, ...LANDING_KINDS).map(event => ({ kind: event.kind, by: event.by, detail: detailOf(event.d) })) : [];
  return { item: row ? { id: row.item_id, status: row.item_status, mergedCommit: row.item_merged_commit ?? null } : null, history };
}

/**
 * The landed commit of item `id` when its landing is pulling, else null: the newest pull_out, pulled or published event is a pull_out,
 * as moves' landingOf reads it [M2,R3,#9099].
 * Why here: the store cannot import the moves cell, and the pull-out job must read the same history PULLED_TABLE will judge before it creates a job.
 *
 * @param {any} board
 * @param {number} id
 * @returns {{ mergedCommit: string } | null}
 */
export function pullingLanding(board, id) {
  const { item, history } = landingSnapshot(board, id);
  const last = history.findLast(event => event.kind !== 'merged');
  if (!item || last?.kind !== 'pull_out') return null;
  const mergedCommit = item.mergedCommit ?? last.detail.mergedCommit ?? null;
  return mergedCommit ? { mergedCommit } : null;
}

/**
 * Record that the revert commit `revert` on main undid item `id`'s landing: one pulled event, so its landing goes from pulling to none.
 * Why the table decides: PULLED_TABLE is the one place that says who may record a revert, which items may take one and what the event
 * carries, so its refusals (COORDINATOR_ONLY, NO_ITEM, NOT_PULLING, REVERT_COMMIT) reach the caller unchanged. Only a Sprint item ever
 * reaches pulling, so a Steady board never writes this event.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, revert: string }} move - the recording seat and the full revert commit the lander pushed
 * @returns {object} the pulled event row
 */
export function recordPulled(board, id, { agentId, revert }) {
  return atomic(board, () => {
    const snapshot = landingSnapshot(board, id);
    const decided = runPulledTable(snapshot, { id, actor: agentId, revert });
    if (decided.refused) throw new Refused(decided.refused.code, decided.refused.message, decided.refused.next);
    let written = null;
    for (const event of decided.events) {
      logEvent(board, event.by, event.kind, id, event.detail);
      written = board.lastEvent;
    }
    return written;
  });
}
