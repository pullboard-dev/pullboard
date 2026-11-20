import { listAgents } from './board/query.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

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
    // A claim next parked while it waited on unmet items was not given up: it is not cooled, and comes back to its builder (#3723).
    if (detail?.review === true || detail?.blockedOn || ids.includes(row.item_id)) continue;
    ids.push(row.item_id);
  }
  return ids;
}

/**
 * The open items whose latest release by this seat was a park on unmet items (release BLOCKED with blockedOn).
 * Why: once the wait ends the seat that built the work gets it before other open items (#3723).
 * @param {any} board
 * @param {string} agentId
 * @returns {Set<number>}
 */
export function parkedClaims(board, agentId) {
  const rows = board.db.prepare(`SELECT e.item_id, e.event_detail FROM event e JOIN item i ON i.item_id = e.item_id
    WHERE e.event_by = ? AND e.event_kind = 'release' AND i.item_status = 'open' ORDER BY e.event_id DESC`).all(agentId);
  const seen = new Set(), parked = new Set();
  for (const row of rows) {
    if (seen.has(row.item_id)) continue;
    seen.add(row.item_id);
    let detail = {};
    try { detail = JSON.parse(row.event_detail); } catch { detail = {}; }
    if (detail?.blockedOn && detail.review !== true) parked.add(row.item_id);
  }
  return parked;
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
  // An item the lane and route said they cannot build is never offered back, not even when nothing else is open (#3014).
  const omitted = new Set([...(selection.omitIds ?? []), ...ineligibleReleaseIds(board, selection.agentId), ...scopedOutFor(board, selection.agentId).map(row => row.id)]);
  const scoped = { ...selection, omitIds: [...omitted] };
  const cooled = recentlyReleased(board, selection.agentId, minutes, now);
  if (!cooled.length) return nextFor(board, scoped);
  const other = nextFor(board, { ...scoped, omitIds: [...scoped.omitIds, ...cooled] });
  return other.item ? other : nextFor(board, scoped);
}

/** Release reasons that say the item is not buildable as scoped for the releasing lane and route [C7]. */
export const RESCOPE_REASONS = Object.freeze(['BLOCKED', 'ROUTED_ELSEWHERE', 'INELIGIBLE']);

/**
 * The open items that need re-scoping for a lane and route: some seat of that lane and route released the item with
 * BLOCKED, ROUTED_ELSEWHERE or INELIGIBLE, and since then the item was not edited, refrozen or re-routed and, for
 * BLOCKED, its named blockers have not all landed. OTHER, BUDGET and TAKEN_OVER never count: they keep today's behaviour.
 * Why: next kept handing an item back to the next seat of the same lane and route, which released it again (#3014).
 *
 * @param {any} board
 * @param {string} lane
 * @param {string} route
 * @returns {{id: number, reasons: string[]}[]}
 */
export function itemsNeedingRescope(board, lane, route) {
  const seats = new Map(listAgents(board).map(seat => [seat.agent_id, seat]));
  const clock = board.clock.now().getTime();
  const rows = board.db.prepare(`SELECT e.event_id, e.event_at, e.item_id, e.event_by, e.event_detail FROM event e JOIN item i ON i.item_id = e.item_id
    JOIN agent a ON a.agent_id = e.event_by
    WHERE e.event_kind = 'release' AND i.item_status = 'open' AND a.agent_lane = ? AND a.agent_route = ? ORDER BY e.event_id`).all(lane, route);
  const byItem = new Map();
  for (const row of rows) {
    let detail = {};
    try { detail = JSON.parse(row.event_detail); } catch { detail = {}; }
    // An automatic claim given back before any work touched the seat says nothing about the scope (#3014, H16).
    if (detail?.review === true || detail?.untouchedAutoClaim === true || !RESCOPE_REASONS.includes(detail?.reasonCode)) continue;
    if (rescopeExpired(detail, row, seats.get(row.event_by), clock)) { byItem.delete(row.item_id); continue; }
    const changed = board.db.prepare("SELECT 1 FROM event WHERE item_id = ? AND event_id > ? AND event_kind IN ('edit','refreeze','route','reroute') LIMIT 1").get(row.item_id, row.event_id);
    if (changed) { byItem.delete(row.item_id); continue; }
    const open = detail.reasonCode === 'BLOCKED' && Array.isArray(detail.blockedOn) && detail.blockedOn.length
      ? detail.blockedOn.filter(id => { const dep = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?').get(id); return dep && dep.item_status !== 'withdrawn' && !dep.item_merged_commit; }) : null;
    if (open && !open.length) { byItem.delete(row.item_id); continue; }
    const entry = byItem.get(row.item_id) ?? { id: row.item_id, since: row.event_at, reasons: [] };
    entry.reasons.push(`${row.event_by}: ${detail.reasonCode}${detail.reason ? ` (${detail.reason})` : ''}, released ${Math.max(0, Math.round((clock - Date.parse(row.event_at)) / 60_000))} min ago`);
    byItem.set(row.item_id, entry);
  }
  return [...byItem.values()];
}

/** How long a BLOCKED release that names no blocker hides the item before next offers it again (#3742). */
export const RESCOPE_BLOCKED_COOLDOWN_MINUTES = 60;

/** How long a seat may be silent and still count as a live session holding its folder (#3742). */
export const RESCOPE_SESSION_MINUTES = 45;

/**
 * Whether a release's exclusion has ended without the item being edited (#3742): a BLOCKED release that names no
 * blocker ends after a bounded cooldown, and a ROUTED_ELSEWHERE release ends once the releasing seat's session is
 * gone or its folder is gone. A BLOCKED release naming blockers ends only when they land, and INELIGIBLE only on an edit.
 *
 * @param {any} detail - The release event's detail.
 * @param {{ event_at: string }} row - The release event.
 * @param {any} seat - The releasing seat's record, if it still exists.
 * @param {number} clock - The board clock's time in ms.
 * @returns {boolean}
 */
function rescopeExpired(detail, row, seat, clock) {
  if (detail.reasonCode === 'BLOCKED' && !(Array.isArray(detail.blockedOn) && detail.blockedOn.length)) {
    return clock - Date.parse(row.event_at) >= RESCOPE_BLOCKED_COOLDOWN_MINUTES * 60_000;
  }
  if (detail.reasonCode !== 'ROUTED_ELSEWHERE') return false;
  const beat = Date.parse(seat?.heartbeatAt ?? '');
  return !seat || !seat.agent_path || !fs.exists(seat.agent_path) || !(clock - beat < RESCOPE_SESSION_MINUTES * 60_000);
}

/** The items to leave out of one seat's next: those released for re-scope for its own lane and route and not yet expired. */
function scopedOutFor(board, agentId) {
  const seat = board.db.prepare('SELECT agent_lane, agent_route FROM agent WHERE agent_id=?').get(agentId);
  return seat ? itemsNeedingRescope(board, seat.agent_lane, seat.agent_route) : [];
}

/**
 * Every open item that needs re-scoping, with the lane and route that gave it back and each release's reason, for the
 * coordinator's status and health (#3014).
 *
 * @param {any} board
 * @returns {{id: number, lane: string, route: string, reasons: string[]}[]}
 */
export function allItemsNeedingRescope(board) {
  const pairs = board.db.prepare('SELECT DISTINCT agent_lane AS lane, agent_route AS route FROM agent WHERE agent_lane IS NOT NULL AND agent_route IS NOT NULL').all();
  return pairs.flatMap(({ lane, route }) => itemsNeedingRescope(board, lane, route).map(row => ({ ...row, lane, route })));
}
