/** The landing half of the health report: accept-to-merged times and the time per landing step [C7]. */

/** The value at a fraction of the sorted list, or 0 for an empty one. */
function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/** A short human duration: 45s, 8m12s or 1h05m. */
function shortDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Summarize landings and landing spans for one window.
 * Why: the gate report showed where submit gates spent their time, but an accepted item's 8 to 10 minutes before it
 * merged were invisible; each landing step now has a span, and each landing its accept-to-merged time.
 *
 * @param {{ landings: { item: number, acceptAt: number, mergedAt: number, forced: boolean }[], spans: object[], since: number, now: number }} input
 * @returns {{ since: string, asOf: string, landed: number, forced: number, acceptToMerged: { p50: number, p90: number, max: number },
 *   slowest: { item: number, ms: number }[], runs: number, phases: { phase: string, runs: number, sumMs: number, p50Ms: number, maxMs: number }[] }}
 */
export function landingHealthSummary({ landings, spans, since, now }) {
  const automatic = landings.filter(row => !row.forced && Number.isFinite(row.acceptAt) && row.mergedAt >= since && row.mergedAt <= now);
  const waits = automatic.map(row => ({ item: row.item, ms: Math.max(0, row.mergedAt - row.acceptAt) }));
  const sorted = waits.map(row => row.ms).sort((a, b) => a - b);
  const inWindow = spans.filter(span => Date.parse(span.end) >= since);
  const byPhase = new Map();
  for (const span of inWindow) {
    const row = byPhase.get(span.phase) ?? { phase: span.phase, runs: new Set(), values: [] };
    row.runs.add(span.job);
    row.values.push(span.ms);
    byPhase.set(span.phase, row);
  }
  const phases = [...byPhase.values()].map(row => {
    const values = row.values.sort((a, b) => a - b);
    return { phase: row.phase, runs: row.runs.size, sumMs: values.reduce((sum, ms) => sum + ms, 0), p50Ms: percentile(values, 0.5), maxMs: values.at(-1) ?? 0 };
  }).sort((a, b) => b.sumMs - a.sumMs);
  return {
    since: new Date(since).toISOString(), asOf: new Date(now).toISOString(),
    landed: automatic.length, forced: landings.filter(row => row.forced && row.mergedAt >= since).length,
    acceptToMerged: { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted.at(-1) ?? 0 },
    slowest: waits.sort((a, b) => b.ms - a.ms).slice(0, 5),
    runs: new Set(inWindow.map(span => span.job)).size,
    phases,
  };
}

/**
 * The landing report's text lines, printed after the gate report.
 *
 * @param {ReturnType<typeof landingHealthSummary>} report
 * @returns {string[]}
 */
export function landingHealthLines(report) {
  const lines = ['', `landing: ${report.landed} accepted item(s) merged${report.forced ? ` (${report.forced} forced hand landing(s) not counted)` : ''}; accept to merged p50 ${shortDuration(report.acceptToMerged.p50)}, p90 ${shortDuration(report.acceptToMerged.p90)}, max ${shortDuration(report.acceptToMerged.max)}`];
  if (report.slowest.length) lines.push(`  slowest: ${report.slowest.map(row => `#${row.item} ${shortDuration(row.ms)}`).join(', ')}`);
  if (!report.phases.length) return [...lines, '  no landing step spans in this window'];
  lines.push(`time per landing step over ${report.runs} landing run(s):`);
  for (const row of report.phases) lines.push(`  ${row.phase.padEnd(16)} ${String(row.runs).padStart(4)} runs  sum ${shortDuration(row.sumMs).padStart(7)}  p50 ${shortDuration(row.p50Ms).padStart(7)}  max ${shortDuration(row.maxMs).padStart(7)}`);
  return lines;
}
