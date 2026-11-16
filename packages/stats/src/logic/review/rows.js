/** Daily review report rows: queue wait, review time and outcome for each review of an item in a window [C7,#8530]. */

/** The board events a review cycle reads: a submit opens it, a reserve starts the review, the rest close it. */
const CLOSERS = { accept: 'accepted', reject: 'rejected', release: 'released', withdraw: 'released', reopen: 'released' };

/** Close an open cycle into a row, leaving unmeasured spans as null rather than zero. */
function row(cycle, kind, at) {
  const outcome = kind ? CLOSERS[kind] : 'pending';
  const reserved = Number.isFinite(cycle.reserveAt);
  const waitEnd = reserved ? cycle.reserveAt : kind === 'accept' || kind === 'reject' ? at : null;
  return {
    item: cycle.item, attempt: cycle.attempt, submitAt: cycle.submitAt, endAt: kind ? at : null, outcome,
    queueWaitMs: waitEnd === null ? null : waitEnd - cycle.submitAt,
    reviewMs: reserved && (kind === 'accept' || kind === 'reject') ? at - cycle.reserveAt : null,
    reviewer: cycle.reviewer ?? null,
  };
}

/**
 * One row per review cycle that started or ended in the window, from the board's recorded events.
 *
 * A submit starts the queue wait, the first reserve after it starts the review, and an accept, reject, release,
 * withdraw or reopen ends it. A cycle still open at the window end reads `pending`. Spans with no recorded boundary
 * are null, so a missing event never reads as an instant review.
 *
 * @param {object[]} history - board event rows (event_id, event_at, event_kind, item_id, event_detail)
 * @param {{from: number, until: number}} window - epoch ms, from inclusive and until exclusive
 * @returns {{window: object, rows: object[]}}
 */
export function reviewRows(history, { from, until }) {
  const open = new Map(), attempts = new Map(), rows = [];
  const inWindow = at => at >= from && at < until;
  for (const event of [...history].sort((a, b) => a.event_id - b.event_id)) {
    const item = event.item_id, kind = event.event_kind, at = Date.parse(event.event_at);
    if (item == null || !Number.isFinite(at) || at >= until) continue;
    if (kind === 'submit') {
      const count = (attempts.get(item) ?? 0) + 1;
      attempts.set(item, count);
      if (open.has(item) && inWindow(open.get(item).submitAt)) rows.push(row(open.get(item), 'release', at));
      open.set(item, { item, attempt: count, submitAt: at });
    } else if (kind === 'reserve' && open.has(item)) {
      const cycle = open.get(item);
      if (!Number.isFinite(cycle.reserveAt)) { cycle.reserveAt = at; cycle.reviewer = event.event_by ?? null; }
    } else if (kind in CLOSERS && open.has(item)) {
      const cycle = open.get(item);
      open.delete(item);
      if (inWindow(cycle.submitAt) || inWindow(at)) rows.push(row(cycle, kind, at));
    }
  }
  for (const cycle of open.values()) if (inWindow(cycle.submitAt)) rows.push(row(cycle, null, until));
  rows.sort((a, b) => a.submitAt - b.submitAt || a.item - b.item);
  return { window: { from, until }, rows };
}

/** One readable line per row, with unmeasured spans stated, never as zero. */
export function reviewRowLines({ rows }) {
  const span = ms => (ms === null ? 'unmeasured' : `${ms} ms`);
  return rows.map(r => `#${r.item} attempt ${r.attempt}: queue wait ${span(r.queueWaitMs)} · review ${span(r.reviewMs)} · ${r.outcome}`);
}
