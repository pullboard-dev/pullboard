/** Replay retained timing receipts without treating a partial sample as a performance achievement [C7]. */
const PHASES = ['waitMs', 'admissionMs', 'setupMs', 'runMs', 'evidenceMs'];
const SAMPLE = 50;

/** Nearest-rank percentiles select an observed duration, never an interpolated faster run. */
function percentile(values, fraction) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
}

/** The canonical receipt phases partition request through completion, including all queue waits. */
function duration(row, operation, now) {
  if (!Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) > now || (row.inherited === true || row.slot?.kind === 'inherited') || operation === 'landing-gate' && row.timingOperation !== operation
    || PHASES.some(key => !Number.isFinite(row[key]) || row[key] < 0)) return null;
  const total = PHASES.reduce((sum, key) => sum + row[key], 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** Select last receipts before validating durations, so unknown rows never improve the sample. */
function sample(receipts, operation, now) {
  const kind = operation === 'submit' ? 'submit' : 'landing';
  const rows = receipts.map((row, index) => ({ row, index, at: Date.parse(row?.at) }))
    .filter(({ row }) => row?.kind === kind && row.inherited !== true && row.slot?.kind !== 'inherited' && row.timingOperation !== 'landing-shard')
    .slice(-SAMPLE).reverse();
  const values = rows.map(({ row }) => duration(row, operation, now));
  const unknown = values.filter(value => value === null).length;
  const oldest = rows.at(-1)?.index ?? 0;
  const unclassified = receipts.slice(oldest).filter(row => row?.malformed === true).length;
  const complete = rows.length === SAMPLE && unknown === 0 && unclassified === 0;
  const p50Ms = rows.length && !unknown && !unclassified ? percentile(values, 0.5) : null;
  const p90Ms = rows.length && !unknown && !unclassified ? percentile(values, 0.9) : null;
  return { operation, requested: SAMPLE, receipts: rows.length, known: rows.length - unknown, unknown, unclassified,
    p50Ms, p90Ms, complete,
    sampleMeetsTargets: complete ? p50Ms < 300000 && p90Ms < 480000 : null,
    from: rows.length ? Number.isFinite(rows.at(-1).at) ? new Date(rows.at(-1).at).toISOString() : null : null,
    to: rows.length ? Number.isFinite(rows[0].at) ? new Date(rows[0].at).toISOString() : null : null };
}

/** A report describes recorded samples only; it never closes the goal requiring a day of real landings. */
export function testTimeBudget(receipts, now = Date.now()) {
  return { version: 1, unit: 'milliseconds', percentile: 'nearest-rank', endToEnd: 'sum-of-five-receipt-phases',
    submit: sample(receipts, 'submit', now), landingGate: sample(receipts, 'landing-gate', now),
    dayOfRealLandings: 'not-asserted' };
}

/** Human-readable values retain UNKNOWN instead of displaying missing observations as zero. */
function displayed(ms) { return ms === null ? 'UNKNOWN' : `${(ms / 1000).toFixed(2)}s`; }

/** Print both complete operation samples, including uncertainty and the unclaimed day-long goal. */
export function testTimeBudgetLines(report) {
  return ['test wall budgets, last 50 receipts each (waits included):',
    ...[report.submit, report.landingGate].map(row => `  ${row.operation}: ${row.receipts}/50 receipts; ${row.unknown} UNKNOWN, ${row.unclassified} unclassified; p50 ${displayed(row.p50Ms)}, p90 ${displayed(row.p90Ms)}; sample targets ${row.sampleMeetsTargets === null ? 'UNKNOWN' : row.sampleMeetsTargets ? 'met' : 'not met'}`),
    '  one day of real landings: not asserted by this measurement report'];
}
