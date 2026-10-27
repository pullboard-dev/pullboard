/** Pure arithmetic over explicit test-work evidence; unknown time never becomes zero [C7]. */

/** Sum observed file execution time, preserving every retry and identifying missing plan coverage. */
function suiteWork(audit, timings) {
  if (!audit) return { minutes: null, knownMinutes: null, receiptId: null, missingFiles: null };
  const rows = timings?.files ?? [];
  const planned = new Set(audit.collection.files);
  const known = rows.filter(row => planned.has(row.file));
  const measured = new Set(known.map(row => row.file));
  const missingFiles = [...planned].filter(file => !measured.has(file));
  const knownMinutes = known.reduce((sum, row) => sum + row.durationMs, 0) / 60_000;
  return { minutes: missingFiles.length ? null : knownMinutes, knownMinutes, receiptId: audit.id,
    source: audit.head, missingFiles, green: audit.green };
}

/** Count each native batch once, from its actual first landed event inside the reporting window. */
export function landedBatchCount(history, since, until) {
  const seen = new Set();
  let count = 0;
  for (const event of history) {
    if (event.event_kind !== 'landing_batch') continue;
    let batch;
    try { batch = JSON.parse(event.event_detail).batch; } catch { continue; }
    if (!batch?.id || batch.state !== 'landed' || seen.has(batch.id)) continue;
    seen.add(batch.id);
    const at = Date.parse(event.event_at);
    if (at >= since && at <= until) count++;
  }
  return count;
}

/** Report serial execution work and a declared lower-bound inventory, never parallel elapsed suite time. */
export function capacitySummary({ value, history, latestAudit, timings, inventory }) {
  const knownMinutes = value.files.reduce((sum, row) => sum + (row.runtimeMs ?? 0), 0) / 60_000;
  const missingExecutions = value.files.reduce((sum, row) => sum + Math.max(0, row.runs - row.timedRuns), 0);
  const unknownReceipts = value.coverage.unknownFileReceipts;
  const landings = landedBatchCount(history, Date.parse(value.since), Date.parse(value.asOf));
  const complete = missingExecutions === 0 && unknownReceipts === 0 && value.coverage.receipts > 0;
  const pure = inventory.filter(row => row.kind === 'pure').length;
  const contract = inventory.filter(row => row.kind === 'contract').length;
  return { since: value.since, asOf: value.asOf,
    suite: { ...suiteWork(latestAudit, timings), measure: 'serial sum of measured per-file execution durations, including retries; not elapsed parallel wall time' },
    perLanding: { minutes: complete && landings ? knownMinutes / landings : null,
      knownMinutes, landings, missingExecutions, unknownReceipts, receipts: value.coverage.receipts,
      measure: 'fourteen-day measured test execution work, failed and retried work included, per distinct landed batch' },
    files: { total: inventory.length, pure, contract, unknown: inventory.length - pure - contract,
      share: inventory.length ? (pure + contract) / inventory.length : null,
      lowerBound: true, measure: 'explicit committed pure/contract declarations; undeclared files remain unknown' } };
}

/** Read only leading declaration comments, never matching examples or executable string contents. */
export function declaredTestBoundary(source) {
  const header = /^(?:#![^\n]*\n)?(?:\s*\/\*[\s\S]*?\*\/|\s*\/\/[^\n]*(?:\n|$))*/u.exec(source)?.[0] ?? '';
  const declarations = [...header.matchAll(/^[ \t]*\*?[ \t]*@pullboard-test-boundary[ \t]+(pure|contract)[ \t]*$/gmu)];
  return declarations.length === 1 ? declarations[0][1] : 'unknown';
}

