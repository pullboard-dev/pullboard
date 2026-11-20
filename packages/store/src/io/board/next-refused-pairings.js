/** Pairings a seat already refused, so next stops re-offering them [C7,#2957]. */

/** How long a seat's recorded refusal of a pairing keeps next from offering it again. */
export const REFUSED_PAIRING_MS = 24 * 60 * 60_000;

/** The earliest event time a refusal still counts from, as the board's ISO event times compare. */
function refusalCutoff(board) {
  return new Date(board.clock.now().getTime() - REFUSED_PAIRING_MS).toISOString();
}

/**
 * Whether this seat's own family check refused a backlog-relaxed review in the last 24 hours [C7,#2957].
 * A relaxed reservation carries a familyRelaxation witness; a seat that released one with a reason code
 * declined same-family review, so next stops relaxing the family requirement for it and offers only
 * reviews the strict family check allows. An explicit `--verify <id>` is unchanged.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {boolean}
 */
export function refusesFamilyRelaxation(board, agentId) {
  // The unary + keeps the time bound off the index choice, so the read seeks the seat's releases by (event_by, event_kind)
  // rather than walking every event the seat made inside the window (#12579).
  const releases = board.db.prepare(`SELECT event_id, item_id FROM event WHERE event_kind='release' AND event_by=? AND +event_at>=?
    AND json_valid(event_detail) AND json_extract(event_detail, '$.review')=1
    AND json_extract(event_detail, '$.reasonCode') IS NOT NULL`).all(agentId, refusalCutoff(board));
  const reserve = board.db.prepare(`SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' AND event_by=? AND event_id<?
    ORDER BY event_id DESC LIMIT 1`);
  return releases.some(row => {
    const detail = reserve.get(row.item_id, agentId, row.event_id)?.event_detail;
    try { return Boolean(detail && JSON.parse(detail).familyRelaxation); }
    catch { return false; /* An unreadable reservation carries no witness, so it records no relaxed refusal. */ }
  });
}
