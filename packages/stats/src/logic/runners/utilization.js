/** Runner utilization by hour: busy slots over total slots per runner and overall, with each slot count's source [C7,#6032]. */

export const HOUR_MS = 3_600_000;

/**
 * Milliseconds a span [start, end) overlaps the hour starting at hourStart.
 *
 * @param {{ start: number, end: number }} span
 * @param {number} hourStart
 * @returns {number}
 */
export function overlapMs(span, hourStart) {
  return Math.max(0, Math.min(span.end, hourStart + HOUR_MS) - Math.max(span.start, hourStart));
}

/** The jobs setting a claim payload carries, or null (same rule as the pulled-capacity reader, #5993). */
export function declaredJobs(text) {
  try {
    const jobs = JSON.parse(text)?.jobs;
    return Number.isSafeInteger(jobs) && jobs >= 1 ? jobs : null;
  } catch { return null; }
}

/** Peak number of spans running at once, by sweeping their edges. */
function peakConcurrent(spans) {
  const edges = spans.flatMap(span => [[span.start, 1], [span.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0, peak = 0;
  for (const [, step] of edges) { now += step; peak = Math.max(peak, now); }
  return peak;
}

/**
 * Compute hourly utilization from job spans.
 * A runner's slot count is the largest jobs setting its claims declared (source "declared"); a runner that never
 * declared one is sized by the most jobs it ran at once (source "observed peak"), so its utilization is a floor.
 * Why per hour: peak and idle hours decide how many slots a day needs, which an average hides.
 *
 * @param {{ runner: string, start: number, end: number, declared?: number|null }[]} spans - One per job that held a slot.
 * @param {{ now: number, windowMinutes?: number }} options
 * @returns {{ windowMinutes: number, runners: { runner: string, slots: number, source: string, busyMinutes: number, utilization: number|null }[], hours: { hour: string, busySlotMinutes: number, totalSlots: number, utilization: number, byRunner: Record<string, number> }[], overall: { slots: number, busyMinutes: number, utilization: number|null }, peak: { hour: string, utilization: number }|null, idleHours: string[] }}
 */
export function runnerUtilization(spans, { now, windowMinutes = 1440 }) {
  const end = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const first = Math.floor((now - windowMinutes * 60_000) / HOUR_MS) * HOUR_MS;
  const per = new Map();
  for (const span of spans) {
    if (!per.has(span.runner)) per.set(span.runner, { spans: [], declared: 0 });
    const entry = per.get(span.runner);
    entry.spans.push(span);
    if (span.declared > entry.declared) entry.declared = span.declared;
  }
  const slotsOf = new Map(), runners = [];
  for (const [runner, entry] of [...per].sort((a, b) => a[0].localeCompare(b[0]))) {
    const slots = entry.declared || peakConcurrent(entry.spans) || 1;
    slotsOf.set(runner, slots);
    runners.push({ runner, slots, source: entry.declared ? 'declared' : 'observed peak', busyMinutes: 0, utilization: null });
  }
  const totalSlots = [...slotsOf.values()].reduce((sum, slots) => sum + slots, 0);
  const hours = [];
  for (let start = first; start < end; start += HOUR_MS) {
    const byRunner = {};
    let busy = 0;
    for (const [runner, entry] of per) {
      const ms = entry.spans.reduce((sum, span) => sum + overlapMs(span, start), 0);
      if (ms) { byRunner[runner] = ms / 60_000; busy += ms; }
    }
    hours.push({ hour: new Date(start).toISOString(), busySlotMinutes: busy / 60_000, totalSlots, utilization: totalSlots ? busy / (totalSlots * HOUR_MS) : 0, byRunner });
  }
  const hoursCount = hours.length;
  for (const row of runners) {
    row.busyMinutes = hours.reduce((sum, hour) => sum + (hour.byRunner[row.runner] ?? 0), 0);
    row.utilization = hoursCount ? row.busyMinutes / (row.slots * hoursCount * 60) : null;
  }
  const busyMinutes = runners.reduce((sum, row) => sum + row.busyMinutes, 0);
  const busyHours = hours.filter(hour => hour.busySlotMinutes > 0);
  const top = busyHours.reduce((best, hour) => (!best || hour.utilization > best.utilization ? hour : best), null);
  return {
    windowMinutes,
    runners,
    hours,
    overall: { slots: totalSlots, busyMinutes, utilization: hoursCount && totalSlots ? busyMinutes / (totalSlots * hoursCount * 60) : null },
    peak: top ? { hour: top.hour, utilization: top.utilization } : null,
    idleHours: hours.filter(hour => hour.busySlotMinutes === 0).map(hour => hour.hour),
  };
}

/** Text lines for pullboard stats runners --utilization. */
export function utilizationLines(report) {
  const pct = value => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  const lines = [`runner utilization, last ${report.windowMinutes} min: ${pct(report.overall.utilization)} of ${report.overall.slots} slots`];
  for (const row of report.runners) lines.push(`  ${row.runner}: ${pct(row.utilization)} of ${row.slots} slots (${row.source}), ${row.busyMinutes.toFixed(1)} busy slot-min`);
  lines.push(report.peak ? `  peak hour ${report.peak.hour}: ${pct(report.peak.utilization)}` : '  peak hour: none');
  lines.push(`  idle hours: ${report.idleHours.length}${report.idleHours.length ? ` (${report.idleHours.join(', ')})` : ''}`);
  return lines;
}
