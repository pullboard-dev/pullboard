/** Command wall time per seat and item, read from the machine-local seat timing records [C7,N2]. */

/** A command that takes longer than this is a conveyor defect: the seat waited on the machine, not on its own work. */
export const CONVEYOR_DEFECT_MS = 30_000;

/** The pth percentile (nearest rank) of an ascending list; 0 for none. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** The summed length of a seat's command spans with overlaps counted once, spans given ascending by start. */
function busyMs(spans) {
  let total = 0, from = -Infinity, to = -Infinity;
  for (const [start, end] of spans) {
    if (start > to) { if (to > from) total += to - from; from = start; to = end; } else if (end > to) to = end;
  }
  return to > from ? total + (to - from) : total;
}

/**
 * Summarize a day of command timing: median and p90 per command, the time from a seat's last `next` to each of its
 * submits per item, each seat's busy fraction of its observed window, and every command over the conveyor limit.
 *
 * Why one pass over sorted rows: the report runs on every `pullboard seats`, and a full day of rows must return in under a second.
 *
 * @param {object[]} records - Rows from the seat timing file; only finished command rows count.
 * @param {{ limitMs?: number }} [options]
 * @returns {{ commands: object[], items: object[], seats: object[], defects: object[] }}
 */
export function commandTimingReport(records, { limitMs = CONVEYOR_DEFECT_MS } = {}) {
  const rows = [];
  for (const row of records) {
    if (row?.kind === 'command' && row.phase === 'end' && Number.isFinite(row.durationMs) && Number.isFinite(row.start) && typeof row.command === 'string') rows.push(row);
  }
  rows.sort((left, right) => left.start - right.start);
  const byCommand = new Map(), bySeat = new Map(), lastNext = new Map(), firstAt = new Map(), anchors = new Map(), items = [], defects = [];
  for (const row of rows) {
    const end = row.start + row.durationMs;
    if (!byCommand.has(row.command)) byCommand.set(row.command, []);
    byCommand.get(row.command).push(row.durationMs);
    if (!bySeat.has(row.seat)) bySeat.set(row.seat, []);
    bySeat.get(row.seat).push([row.start, end]);
    if (row.durationMs > limitMs) defects.push({ command: row.command, seat: row.seat, item: row.item ?? null, durationMs: row.durationMs, at: row.start });
    if (row.command === 'next') lastNext.set(row.seat, row.start);
    if (row.item != null) {
      const key = `${row.seat}\0${row.item}`;
      if (!firstAt.has(key)) { firstAt.set(key, row.start); anchors.set(key, lastNext.get(row.seat) ?? row.start); }
      if (row.command === 'submit') items.push({ seat: row.seat, item: row.item, nextToSubmitMs: Math.max(0, end - anchors.get(key)) });
    }
  }
  const commands = [...byCommand].map(([command, durations]) => {
    durations.sort((left, right) => left - right);
    return { command, count: durations.length, medianMs: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9), maxMs: durations[durations.length - 1] };
  }).sort((left, right) => right.p90Ms - left.p90Ms || (left.command < right.command ? -1 : 1));
  const seats = [...bySeat].map(([seat, spans]) => {
    const window = spans[spans.length - 1][1] - spans[0][0];
    const busy = busyMs(spans);
    return { seat, busyMs: busy, windowMs: window, busyFraction: window > 0 ? Math.min(1, busy / window) : 0 };
  }).sort((left, right) => (left.seat < right.seat ? -1 : 1));
  defects.sort((left, right) => right.durationMs - left.durationMs);
  return { commands, items, seats, defects };
}

/** Seconds with one decimal for a report line. */
const seconds = ms => `${(ms / 1000).toFixed(1)}s`;

/** The report as plain lines: one per command, one per seat, one per submitted item, and each conveyor defect. */
export function commandTimingLines(report) {
  if (!report.commands.length) return [];
  return [
    'command wall time (median / p90 / count):',
    ...report.commands.map(row => `  ${row.command}: ${seconds(row.medianMs)} / ${seconds(row.p90Ms)} / ${row.count}`),
    ...report.seats.map(row => `  ${row.seat}: busy ${Math.round(row.busyFraction * 100)}% of ${seconds(row.windowMs)}`),
    ...report.items.map(row => `  #${row.item} ${row.seat}: next to submit ${seconds(row.nextToSubmitMs)}`),
    ...report.defects.map(row => `  conveyor defect: ${row.command} took ${seconds(row.durationMs)} on ${row.seat}${row.item == null ? '' : ` #${row.item}`}`),
  ];
}
