/** Descriptive conversion priority; no report is permission to delete or bypass a test [C7]. */

/** Keep a historical complete mean separate from a single observed fallback. */
function duration(row) {
  return Number.isFinite(row.meanRuntimeMs) && row.meanRuntimeMs >= 0 ? row.meanRuntimeMs
    : Number.isFinite(row.lastObservedRuntime?.durationMs) && row.lastObservedRuntime.durationMs >= 0
      ? row.lastObservedRuntime.durationMs : null;
}

/** Follow measured value for real catches; absent positive catch evidence, compare observed cost. */
export function testConversionPlan(report) {
  const catches = report.files.some(row => row.realCatches > 0);
  const positive = report.files.some(row => row.realCatches > 0 && duration(row) !== null);
  const order = report.files.map((row, index) => ({ file: row.file, runtimeMs: duration(row),
    runtimeSource: row.meanRuntimeMs === null ? row.lastObservedRuntime?.source ?? null : 'complete historical mean',
    realCatches: row.realCatches, valuePerRun: row.valuePerRun, reportIndex: index,
    requiresPersonApprovalForRemoval: true,
    proposal: row.realCatches === 0 ? 'review conversion or ask the person before removal; missing evidence is not proof of no defects' : 'convert without changing assertions' }))
    .filter(row => row.runtimeMs !== null)
    .sort((a, b) => positive ? Number(b.realCatches > 0) - Number(a.realCatches > 0)
      || a.reportIndex - b.reportIndex : b.runtimeMs - a.runtimeMs || a.file.localeCompare(b.file));
  return { basis: positive ? 'real-catch files first, preserving test-value report order'
      : catches ? 'recorded catches lack timed conversion candidates; measured-cost order for known costs'
        : 'no positive recorded catches; measured-cost order',
    order, unknown: report.files.filter(row => duration(row) === null).map(row => row.file),
    removesTests: false };
}
