/** Daily review report: escaped defects, overturned rejects and recurring causes with their owners [C7,#8532]. */

/** Read an event's JSON detail, treating an unreadable one as empty so one bad row never hides the rest. */
function detailOf(event) {
  if (event.event_detail && typeof event.event_detail === 'object') return event.event_detail;
  try { return JSON.parse(event.event_detail ?? '{}') ?? {}; } catch { return {}; }
}

/** The cause key a recorded event names: its typed cause, else its reason code, else unknown. */
const causeOf = detail => (typeof detail.cause === 'string' && detail.cause) || (typeof detail.reason === 'string' && detail.reason) || 'unknown';

/**
 * Escaped defects, overturned rejects and causes that recur in a window.
 *
 * - An escaped defect is an accepted item that later reopened, or that a recorded `main-red` event names.
 * - An overturned reject is a reject the review later reversed: an `overturn` event, or an accept of the same
 *   submitted commit the reject judged.
 * - A cause recurring in the window (reject, reopen or escape named it at least `recurAt` times) is listed with
 *   the open item that owns it in `owners`, or flagged `unowned: true`.
 *
 * @param {object[]} history - board event rows (event_id, event_at, event_kind, item_id, event_detail)
 * @param {{from: number, until: number}} window - epoch ms, from inclusive and until exclusive
 * @param {{owners?: Object<string, number>, recurAt?: number}} [options] - owners maps a cause key to its open item id
 * @returns {{window: object, escaped: object[], overturned: object[], recurring: object[]}}
 */
export function escapeReport(history, { from, until }, { owners = {}, recurAt = 2 } = {}) {
  const escaped = [], overturned = [], causes = new Map();
  const accepted = new Set(), submitted = new Map(), rejected = new Map();
  const count = (cause, item) => { const entry = causes.get(cause) ?? { cause, count: 0, items: new Set() }; entry.count += 1; entry.items.add(item); causes.set(cause, entry); };
  for (const event of [...history].sort((a, b) => a.event_id - b.event_id)) {
    const item = event.item_id, kind = event.event_kind, at = Date.parse(event.event_at);
    if (!Number.isFinite(at) || at >= until) continue;
    const detail = detailOf(event), seen = at >= from;
    const target = item ?? detail.item ?? null;
    if (kind === 'submit' && item != null) submitted.set(item, detail.commit ?? null);
    else if (kind === 'reject' && item != null) {
      rejected.set(item, { at, commit: submitted.get(item) ?? null, cause: causeOf(detail) });
      if (seen) count(causeOf(detail), item);
    } else if (kind === 'accept' && item != null) {
      const earlier = rejected.get(item);
      if (earlier && earlier.commit === (submitted.get(item) ?? null) && seen) overturned.push({ item, rejectedAt: earlier.at, acceptedAt: at, how: 'accepted same commit' });
      rejected.delete(item); accepted.add(item);
    } else if (kind === 'overturn' && item != null) {
      if (seen) overturned.push({ item, rejectedAt: rejected.get(item)?.at ?? null, acceptedAt: at, how: 'overturn event' });
      rejected.delete(item);
    } else if (kind === 'reopen' && item != null && accepted.has(item)) {
      accepted.delete(item);
      if (seen) { escaped.push({ item, at, how: 'reopened', cause: causeOf(detail) }); count(causeOf(detail), item); }
    } else if (kind === 'main-red' && seen && target != null && accepted.has(target)) {
      escaped.push({ item: target, at, how: 'main red', cause: causeOf(detail) });
      count(causeOf(detail), target);
    }
  }
  const recurring = [...causes.values()].filter(entry => entry.count >= recurAt).sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause))
    .map(({ cause, count: times, items }) => ({ cause, count: times, items: [...items].sort((a, b) => a - b), ...(owners[cause] != null ? { owner: owners[cause] } : { unowned: true }) }));
  return { window: { from, until }, escaped, overturned, recurring };
}

/** One readable line per escape, overturn and recurring cause. */
export function escapeLines({ escaped, overturned, recurring }) {
  return [
    ...escaped.map(e => `escaped #${e.item}: ${e.how}`),
    ...overturned.map(o => `overturned reject #${o.item}: ${o.how}`),
    ...recurring.map(r => `recurring ${r.cause} x${r.count}: ${r.unowned ? 'unowned' : `owned by #${r.owner}`}`),
  ];
}
