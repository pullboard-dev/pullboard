/**
 * The release cooldown for next (#2587): a seat that released a build item is not offered it again for
 * claims.releaseCooldownMinutes, unless nothing else is open for it. On 2 Nov next kept handing one item back to
 * the seat that had just let it go, so the seat looped on release and next.
 */

/**
 * The open items this seat released as builds within the last `minutes`, newest first. Review releases do not
 * count: giving a review back says nothing about wanting the build.
 * @param {any} board
 * @param {string} agentId
 * @param {number} minutes
 * @param {number} [now]
 * @returns {number[]}
 */
export function recentlyReleased(board, agentId, minutes, now = Date.now()) {
  if (!(minutes > 0)) return [];
  const since = new Date(now - minutes * 60_000).toISOString();
  const rows = board.db.prepare(`SELECT e.item_id, e.event_detail FROM event e JOIN item i ON i.item_id = e.item_id
    WHERE e.event_by = ? AND e.event_at >= ? AND e.event_kind = 'release' AND i.item_status = 'open' ORDER BY e.event_id DESC`).all(agentId, since);
  const ids = [];
  for (const row of rows) {
    let detail = {};
    try { detail = JSON.parse(row.event_detail); } catch { detail = {}; }
    if (detail?.review === true || ids.includes(row.item_id)) continue;
    ids.push(row.item_id);
  }
  return ids;
}

/**
 * Build items explicitly marked INELIGIBLE are never offered automatically to that releasing seat.
 * Only that seat's own release events count, so coordinator maintenance and releases of another holder stay local.
 * @param {any} board
 * @param {string} agentId
 * @returns {number[]}
 */
export function ineligibleReleaseIds(board, agentId) {
  const rows = board.db.prepare(`SELECT item_id, event_detail FROM event WHERE event_by = ? AND event_kind = 'release' ORDER BY event_id`).all(agentId);
  const ids = new Set();
  for (const row of rows) {
    let detail = {};
    try { detail = JSON.parse(row.event_detail); } catch { detail = {}; }
    if (detail?.reasonCode !== 'INELIGIBLE' || detail.review === true) continue;
    ids.add(row.item_id);
  }
  return [...ids];
}

/**
 * Pick the next build with the cooldown applied: first with this seat's recent releases left out, and only when
 * that finds nothing, the ordinary pick, so a seat with nothing else open still gets its released item back.
 * @param {any} board
 * @param {any} selection the nextFor selection
 * @param {number} minutes the configured cooldown; 0 turns it off
 * @param {(board: any, selection: any) => any} nextFor
 * @param {number} [now] the board clock's time
 * @returns {any} nextFor's result
 */
export function nextWithReleaseCooldown(board, selection, minutes, nextFor, now = Date.now()) {
  const ineligible = ineligibleReleaseIds(board, selection.agentId);
  selection = { ...selection, omitIds: [...new Set([...(selection.omitIds ?? []), ...ineligible])] };
  const cooled = recentlyReleased(board, selection.agentId, minutes, now);
  if (!cooled.length) return nextFor(board, selection);
  const other = nextFor(board, { ...selection, omitIds: [...(selection.omitIds ?? []), ...cooled] });
  return other.item ? other : nextFor(board, selection);
}
