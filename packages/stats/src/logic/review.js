/** Review flow: queue depth by hour, time from submit to verdict, and reject rate per reviewer family [C7,#6138]. */
import { nearestRank } from './runners/rank.js';

/** The board events this view reads: a submit starts a wait; the rest end it without a verdict; a reserve holds it for a reviewer. */
export const REVIEW_FLOW_KINDS = ['submit', 'release', 'reopen', 'withdraw', 'merged', 'reserve'];

const HOUR_MS = 3_600_000;

/** Percentiles of a list of durations, nearest rank. */
function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: nearestRank(sorted, 0.5), p90Ms: nearestRank(sorted, 0.9), maxMs: sorted.length ? sorted.at(-1) : null };
}

/** The reviewer family as recorded, lowercased; a verdict that recorded none is "unknown". */
const familyOf = value => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'unknown');

/**
 * Review queue depth by hour, time from submit to verdict, and reject rate per reviewer family.
 *
 * A submit puts an item in the queue; it leaves at the item's first verdict, or at a release, reopen, withdraw or merge
 * that comes first. Depth is read at the start of each hour of the window, with the peak inside the hour; `reserved`
 * is how many of the queued items held a live reviewer reservation then. Time to verdict is measured from the latest
 * submit before each verdict in the window. Families are as recorded on the verdict, so no vendor list is needed.
 *
 * @param {{events: {kind: string, item: number|null, at: number, until?: number|null}[], verdicts: {item: number, at: number, decision: string, family: string|null}[], reservedNow: object[]}} input - events in board order (epoch ms), verdict rows, and items reserved at the window end
 * @param {{from: number, until: number}} window - epoch ms
 * @returns {{window: object, queue: object[], toVerdict: object, families: object[], reservedNow: object[]}}
 */
export function reviewFlow({ events, verdicts, reservedNow }, { from, until }) {
  const submitsOf = new Map();
  const endsOf = new Map();
  const reservations = [];
  for (const event of events) {
    if (event.item === null || event.item === undefined) continue;
    if (event.kind === 'submit') {
      if (!submitsOf.has(event.item)) submitsOf.set(event.item, []);
      submitsOf.get(event.item).push(event.at);
    } else if (event.kind === 'reserve') {
      if (Number.isFinite(event.until)) reservations.push({ item: event.item, from: event.at, until: event.until });
    } else {
      if (!endsOf.has(event.item)) endsOf.set(event.item, []);
      endsOf.get(event.item).push(event.at);
    }
  }
  const verdictsOf = new Map();
  for (const verdict of verdicts) {
    if (!verdictsOf.has(verdict.item)) verdictsOf.set(verdict.item, []);
    verdictsOf.get(verdict.item).push(verdict.at);
  }
  /** Every wait: the item, when it was submitted and when it left the queue (Infinity while queued). */
  const stays = [];
  for (const [item, starts] of submitsOf) {
    for (const start of starts) {
      const exits = [...(verdictsOf.get(item) ?? []), ...(endsOf.get(item) ?? [])].filter(at => at >= start);
      stays.push({ item, start, end: exits.length ? Math.min(...exits) : Infinity });
    }
  }
  const reservedAt = (stay, t) => reservations.some(r => r.item === stay.item && r.from <= t && t < r.until);
  const queue = [];
  for (let hour = Math.floor(from / HOUR_MS) * HOUR_MS; hour < until; hour += HOUR_MS) {
    const queued = stays.filter(stay => stay.start <= hour && hour < stay.end);
    const edges = [];
    for (const stay of stays) {
      if (stay.start < hour + HOUR_MS && stay.end > hour) { edges.push([Math.max(stay.start, hour), 1]); edges.push([Math.min(stay.end, hour + HOUR_MS), -1]); }
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let live = 0, peak = 0;
    for (const [, step] of edges) { live += step; if (live > peak) peak = live; }
    queue.push({ hour: new Date(hour).toISOString(), depth: queued.length, peak, reserved: queued.filter(stay => reservedAt(stay, hour)).length });
  }
  const inside = verdicts.filter(verdict => verdict.at >= from && verdict.at < until);
  const waited = verdict => {
    const starts = (submitsOf.get(verdict.item) ?? []).filter(at => at <= verdict.at);
    return starts.length ? verdict.at - Math.max(...starts) : null;
  };
  const byFamily = new Map();
  for (const verdict of inside) {
    const family = familyOf(verdict.family);
    if (!byFamily.has(family)) byFamily.set(family, { family, accepts: 0, rejects: 0, waits: [] });
    const row = byFamily.get(family);
    if (verdict.decision === 'REJECT') row.rejects += 1; else if (verdict.decision === 'ACCEPT') row.accepts += 1;
    const wait = waited(verdict);
    if (wait !== null) row.waits.push(wait);
  }
  const families = [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family)).map(row => {
    const verdictCount = row.accepts + row.rejects;
    return { family: row.family, verdicts: verdictCount, accepts: row.accepts, rejects: row.rejects,
      rejectRate: verdictCount ? Math.round(row.rejects / verdictCount * 1000) / 1000 : null, toVerdict: spread(row.waits) };
  });
  return {
    window: { from: new Date(from).toISOString(), until: new Date(until).toISOString() },
    queue,
    toVerdict: spread(inside.map(waited).filter(wait => wait !== null)),
    families,
    reservedNow,
  };
}

/** Human lines for the review flow report. */
export function reviewFlowLines(report) {
  const seconds = value => value === null ? 'unmeasured' : `${(value / 1000).toFixed(1)}s`;
  const { toVerdict } = report;
  const lines = [`review: ${toVerdict.samples} verdicts timed; submit to verdict p50 ${seconds(toVerdict.p50Ms)} p90 ${seconds(toVerdict.p90Ms)} max ${seconds(toVerdict.maxMs)}`];
  for (const row of report.families) {
    lines.push(`${row.family}: ${row.verdicts} verdicts, ${row.rejects} rejected (${row.rejectRate === null ? 'no rate' : `${(row.rejectRate * 100).toFixed(1)}%`}); p50 ${seconds(row.toVerdict.p50Ms)} p90 ${seconds(row.toVerdict.p90Ms)}`);
  }
  const deepest = report.queue.reduce((most, row) => row.peak > most.peak ? row : most, { peak: 0, hour: null });
  lines.push(`queue: ${report.queue.length} hours; deepest ${deepest.peak}${deepest.hour ? ` in the hour of ${deepest.hour}` : ''}; ${report.reservedNow.length} items reserved at the end`);
  return lines;
}
