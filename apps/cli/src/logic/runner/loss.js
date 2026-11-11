/** Observed native transport refusals, without turning missing telemetry into a healthy-host claim [C7,C6]. */
const DAY_MS = 86_400_000;

/** Count distinct retained native attempts in a half-open day window; repeated receipt copies count once. */
export function runnerLossHealth(receipts, now = Date.now()) {
  const rows = new Map(), seen = new Set();
  let unlocalized = 0;
  for (const receipt of receipts) {
    if (!Array.isArray(receipt?.infrastructureAttempts)) continue;
    for (const attempt of receipt.infrastructureAttempts) {
      if (attempt?.code !== 'TRANSPORT_LOST') continue;
      const at = Date.parse(attempt.at), runner = attempt.runner;
      if (!Number.isFinite(at) || typeof runner !== 'string' || !runner.trim()) { unlocalized++; continue; }
      if (at < now - DAY_MS || at > now) continue;
      const reason = typeof attempt.diagnostic?.reason === 'string' ? attempt.diagnostic.reason : 'unknown';
      const request = attempt.diagnostic?.request;
      const key = JSON.stringify([runner, typeof request === 'string' && request ? request : [attempt.at, reason]]);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = rows.get(runner) ?? { runner, count: 0, last: attempt.at, reasons: Object.create(null) };
      row.count++;
      if (Date.parse(row.last) < at) row.last = attempt.at;
      row.reasons[reason] = (row.reasons[reason] ?? 0) + 1;
      rows.set(runner, row);
    }
  }
  return { window: '1d', since: new Date(now - DAY_MS).toISOString(), at: new Date(now).toISOString(),
    coverage: 'retained-native-attempts-only', unlocalized,
    runners: [...rows.values()].sort((a, b) => b.count - a.count || a.runner.localeCompare(b.runner)) };
}

/** Name the measured classification, not a diagnosed network or SSH outage; missing records remain unknown. */
export function runnerLossLines(report) {
  if (!report.runners.length && !report.unlocalized) return [];
  return ['runner transport refusals in the last day (retained native attempts; incomplete history is possible):',
    ...report.runners.map(row => `  ${row.runner}: ${row.count}; ${Object.entries(row.reasons).sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} ${count}`).join(', ')}; last ${row.last}`),
    ...(report.unlocalized ? [`  ${report.unlocalized} retained transport refusal record(s) lack a usable runner or timestamp; not assigned to a host`] : [])];
}
