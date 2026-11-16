/** Daily review report: each reject classified by cause, and reservations lost before a verdict [C7,#8531]. */

/** The classes a reject can fall in, in the order the rules below test them. */
export const REJECT_CLASSES = ['lane/hold', 'stale patch', 'main drift', 'new red', 'clause unmet'];

/** Read an event's JSON detail, treating an unreadable one as empty so one bad row never hides the rest. */
function detailOf(event) {
  if (event.event_detail && typeof event.event_detail === 'object') return event.event_detail;
  try { return JSON.parse(event.event_detail ?? '{}') ?? {}; } catch { return {}; }
}

/**
 * Classify one reject from what the board recorded on it, never from its prose note.
 *
 * Rules, first match wins: a reject that held the item or lane is `lane/hold`; reason STALE_HEAD is `stale patch`;
 * a recorded main-red cause is `main drift`; TEST_FAILURE is `new red`; anything else names a clause the work did
 * not meet, so it is `clause unmet`.
 *
 * @param {{ reason?: string, held?: boolean, hold?: boolean, cause?: string, pipelineCause?: {type?: string} }} detail - the reject event's recorded detail
 * @returns {string} one of REJECT_CLASSES
 */
export function classifyReject(detail) {
  if (detail.held === true || detail.hold === true || detail.cause === 'lane' || detail.cause === 'hold') return 'lane/hold';
  if (detail.reason === 'STALE_HEAD') return 'stale patch';
  if (detail.pipelineCause?.type === 'main-red' || detail.cause === 'main-red' || detail.cause === 'main-drift') return 'main drift';
  if (detail.reason === 'TEST_FAILURE') return 'new red';
  return 'clause unmet';
}

/**
 * Classified rejects and reservations lost mid-review for the events in a window.
 *
 * A reservation is lost when the item's review ends without a verdict: it is released, withdrawn, reopened,
 * taken over by a second reserve, or its recorded `until` passes before any verdict or the window end.
 *
 * @param {object[]} history - board event rows (event_id, event_at, event_kind, item_id, event_detail)
 * @param {{from: number, until: number}} window - epoch ms, from inclusive and until exclusive
 * @returns {{window: object, rejects: object[], classes: Object<string, number>, lostReservations: object[]}}
 */
export function rejectReport(history, { from, until }) {
  const rejects = [], lost = [], reserved = new Map();
  const lose = (cycle, how, at) => { if (cycle.at < until) lost.push({ item: cycle.item, reservedAt: cycle.at, lostAt: at, how, reviewer: cycle.by }); };
  for (const event of [...history].sort((a, b) => a.event_id - b.event_id)) {
    const item = event.item_id, kind = event.event_kind, at = Date.parse(event.event_at);
    if (item == null || !Number.isFinite(at) || at >= until) continue;
    const held = reserved.get(item);
    if (held && Number.isFinite(held.until) && held.until <= at && at >= from && !['accept', 'reject'].includes(kind)) { lose(held, 'expired', held.until); reserved.delete(item); }
    if (kind === 'reserve') {
      if (reserved.has(item)) lose(reserved.get(item), 'taken over', at);
      reserved.set(item, { item, at, by: event.event_by ?? null, until: Date.parse(detailOf(event).until) });
    } else if (kind === 'reject' || kind === 'accept') {
      reserved.delete(item);
      if (kind === 'reject' && at >= from) {
        const detail = detailOf(event);
        rejects.push({ item, at, reason: detail.reason ?? null, clause: detail.clause ?? null, class: classifyReject(detail) });
      }
    } else if (['release', 'withdraw', 'reopen'].includes(kind) && reserved.has(item)) {
      lose(reserved.get(item), kind, at);
      reserved.delete(item);
    }
  }
  for (const cycle of reserved.values()) if (Number.isFinite(cycle.until) && cycle.until < until) lose(cycle, 'expired', cycle.until);
  const inWindow = lostEntry => lostEntry.lostAt >= from;
  const classes = Object.fromEntries(REJECT_CLASSES.map(name => [name, rejects.filter(r => r.class === name).length]));
  return { window: { from, until }, rejects, classes, lostReservations: lost.filter(inWindow) };
}

/** One readable line per class and one for lost reservations. */
export function rejectLines({ classes, lostReservations }) {
  return [...Object.entries(classes).map(([name, count]) => `rejects ${name}: ${count}`), `reservations lost mid-review: ${lostReservations.length}`];
}
