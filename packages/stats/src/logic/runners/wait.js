/** Slot wait (queued to running) and queue depth per job kind and hour, from job step timestamps [C7]. */
import { nearestRank } from './rank.js';

const HOUR_MS = 3_600_000;
/** Steps that mean a runner or worker took the job, earliest one wins. */
const START_STEPS = new Set(['running', 'claimed', 'started', 'reserved']);
/** Steps that mean the job was put on the queue, earliest one wins; a job with neither is queued at creation. */
const QUEUE_STEPS = new Set(['queued', 'offered']);
/** Steps a job still waiting for a slot sits in. */
const WAITING_STEPS = new Set(['queued', 'offered']);
/** A job still unstarted this long after queuing stops counting as waiting: it was abandoned, not queued. */
export const ABANDONED_AFTER_MS = 6 * HOUR_MS;

/** The step names the reader must load for these rows. */
export const WAIT_STEP_NAMES = [...QUEUE_STEPS, ...START_STEPS];

/**
 * Turn jobs and their steps into wait rows.
 *
 * @param {{id: string, kind: string, step: string, created: number, steps: {name: string, seq: number, at: number}[]}[]} jobs
 * @returns {{id: string, kind: string, queuedAt: number, startedAt: number|null, open: boolean}[]}
 */
export function waitRows(jobs) {
  return jobs.map(job => {
    const queued = job.steps.filter(step => QUEUE_STEPS.has(step.name)).map(step => step.at);
    const started = job.steps.filter(step => START_STEPS.has(step.name)).map(step => step.at);
    return {
      id: job.id,
      kind: job.kind,
      queuedAt: queued.length ? Math.min(...queued) : job.created,
      startedAt: started.length ? Math.min(...started) : null,
      open: WAITING_STEPS.has(job.step),
    };
  });
}

/**
 * Wait statistics and queue depth per job kind and hour.
 *
 * A wait counts in the hour its job started. Depth is the number of jobs queued and not yet started at an instant; it
 * is reported at the start and end of each hour and as the peak inside it. A job never started counts as waiting only
 * while it is open and younger than `abandonedAfterMs`.
 *
 * @param {{kind: string, queuedAt: number, startedAt: number|null, open: boolean}[]} rows
 * @param {{from: number, until: number, abandonedAfterMs?: number}} window - epoch ms; `from` is rounded down to the hour
 * @returns {{from: string, until: string, hours: object[], kinds: object[]}}
 */
export function runnerWaits(rows, { from, until, abandonedAfterMs = ABANDONED_AFTER_MS }) {
  const first = Math.floor(from / HOUR_MS) * HOUR_MS;
  /** The instant a job stops waiting: its start, or for an unstarted open job its abandonment. */
  const endOf = row => row.startedAt ?? (row.open ? row.queuedAt + abandonedAfterMs : null);
  const spans = rows.map(row => ({ kind: row.kind, from: row.queuedAt, to: endOf(row), startedAt: row.startedAt }))
    .filter(span => span.to !== null && span.to >= span.from);
  const kinds = [...new Set(spans.map(span => span.kind))].sort();
  const hours = [];
  for (let start = first; start < until; start += HOUR_MS) {
    const end = start + HOUR_MS;
    for (const kind of kinds) {
      const own = spans.filter(span => span.kind === kind);
      const waits = own.filter(span => span.startedAt !== null && span.startedAt >= start && span.startedAt < end)
        .map(span => span.startedAt - span.from).sort((a, b) => a - b);
      /** Jobs waiting at an instant: queued at or before it, not yet started. */
      const depthAt = instant => own.filter(span => span.from <= instant && instant < span.to).length;
      const arrivals = own.filter(span => span.from > start && span.from < end).map(span => span.from);
      const depthPeak = Math.max(depthAt(start), ...arrivals.map(depthAt));
      if (!waits.length && !depthPeak && !depthAt(end)) continue;
      hours.push({ hour: new Date(start).toISOString(), kind, count: waits.length,
        p50Ms: nearestRank(waits, 0.5), p90Ms: nearestRank(waits, 0.9), maxMs: waits.length ? waits.at(-1) : null,
        depthStart: depthAt(start), depthPeak, depthEnd: depthAt(end) });
    }
  }
  const total = kind => spans.filter(span => span.kind === kind && span.startedAt !== null && span.startedAt >= first && span.startedAt < until)
    .map(span => span.startedAt - span.from).sort((a, b) => a - b);
  return { from: new Date(first).toISOString(), until: new Date(until).toISOString(), hours,
    kinds: kinds.map(kind => { const waits = total(kind); return { kind, count: waits.length, p50Ms: nearestRank(waits, 0.5), p90Ms: nearestRank(waits, 0.9), maxMs: waits.length ? waits.at(-1) : null }; })
      .filter(row => row.count) };
}

/** Human lines for the wait report. */
export function runnerWaitLines(report) {
  const seconds = value => value === null ? 'unmeasured' : `${(value / 1000).toFixed(1)}s`;
  const lines = [`runner slot waits ${report.from} to ${report.until}`];
  for (const row of report.kinds) lines.push(`${row.kind}: ${row.count} started, wait p50 ${seconds(row.p50Ms)} p90 ${seconds(row.p90Ms)} max ${seconds(row.maxMs)}`);
  for (const row of report.hours) lines.push(`${row.hour} ${row.kind}: ${row.count} started, p50 ${seconds(row.p50Ms)} p90 ${seconds(row.p90Ms)} max ${seconds(row.maxMs)}; depth start ${row.depthStart} peak ${row.depthPeak} end ${row.depthEnd}`);
  if (!report.kinds.length) lines.push('no job started in this window');
  return lines;
}
