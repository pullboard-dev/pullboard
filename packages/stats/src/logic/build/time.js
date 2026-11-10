/** Project build intervals from recorded claim/submit boundaries, retaining missing evidence [B35,R1,R2,C7]. */
import { proofEventDetail } from '../../../../kernel/browser.js';

/** Show each item's latest landed build; the caller supplies the item scorer through its front door. */
export function buildTimeStats(history, items, catalog, scoreCriterion) {
  const current = new Map(items.map(item => [item.item_id, item]));
  const traces = new Map(), landed = new Map();
  for (const event of [...history].sort((a, b) => a.event_id - b.event_id)) {
    if (event.item_id == null) continue;
    const id = event.item_id, detail = proofEventDetail(event);
    const trace = traces.get(id) ?? { claim: null, submitted: null };
    traces.set(id, trace);
    const at = Date.parse(event.event_at);
    if (event.event_kind === 'claim') { trace.claim = Number.isFinite(at) ? at : null; trace.submitted = null; }
    if (event.event_kind === 'submit') trace.submitted = { at, claim: trace.claim };
    if (['release', 'lapse', 'reopen', 'reject', 'withdraw'].includes(event.event_kind) && !detail.review) trace.claim = null;
    if (event.event_kind === 'merged') {
      const submit = trace.submitted;
      const buildMinutes = submit && submit.claim !== null && Number.isFinite(submit.at) && submit.at >= submit.claim && submit.at <= at
        ? (submit.at - submit.claim) / 60_000 : null;
      const item = current.get(id);
      landed.set(id, { item: id, title: item?.item_title ?? '', landedAt: event.event_at, buildMinutes,
        size: scoreCriterion(item?.item_criterion ?? '', catalog), sizeBasis: 'current criterion' });
    }
  }
  const rows = [...landed.values()].reverse();
  return { version: 1, items: rows, over15Minutes: rows.filter(row => row.buildMinutes !== null && row.buildMinutes > 15) };
}

/** Keep unmeasured builds visible and expose the size breakdown used to tune the threshold. */
export function buildTimeLines(report) {
  return ['build time: last claim to submit; size uses the current criterion', ...report.items.map(row =>
    `#${row.item}: ${row.buildMinutes === null ? 'unmeasured' : `${row.buildMinutes.toFixed(2)} build minutes`} · size ${row.size.score} (${row.size.files.length} files, ${row.size.cells.length} cells, ${row.size.clauses} clauses)${row.buildMinutes > 15 ? ' · exceeds 15 minutes' : ''}`)];
}
