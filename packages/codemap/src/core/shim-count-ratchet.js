/** Newly introduced physical shims require an exact first move, even during advisory migration [C7,CD64]. */
export function shimCountProblems({ before, after, beforeInventory, afterInventory }) {
  const existing = new Set(before.metrics.shims.findings.map(row => row.key));
  const problems = shimBaselineProblems(after);
  if (before.shimBaseline && !after.shimBaseline) problems.push('restore the committed shim count baseline');
  for (const { key } of after.metrics.shims.findings) {
    if (existing.has(key) || key.startsWith('temporary:')) continue;
    const target = after.pathMap?.[key];
    const moved = target && !Object.hasOwn(before.pathMap ?? {}, key)
      && beforeInventory.files.has(key) && !beforeInventory.files.has(target)
      && afterInventory.files.has(target);
    if (!moved) problems.push(`shim count rose without a cells move: ${key}; remove the forwarding shim and import its cell front door`);
  }
  return problems;
}

/** Keep counts by cell so unrelated shim removals merge as separate metadata rows. */
export function shimCountBaseline(report) {
  const cells = {};
  for (const row of report.metrics.shims.findings) {
    const target = report.pathMap?.[row.key] ?? report.shimTargets?.[row.key] ?? row.key;
    const cell = /^(?:packages|apps)\/([^/]+)\//u.exec(target)?.[1]
      ?? (row.key.startsWith('temporary:') ? 'temporary' : 'unmapped');
    cells[cell] = (cells[cell] ?? 0) + row.count;
  }
  return { version: 1, cells: Object.fromEntries(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b))) };
}

/** The committed count snapshot must describe the actual source, independently of old advisory allowances. */
export function shimBaselineProblems(report) {
  const recorded = report.shimBaseline;
  if (recorded === null || recorded === undefined) return [];
  const valid = recorded.version === 1 && recorded.cells && typeof recorded.cells === 'object' && !Array.isArray(recorded.cells)
    && Object.values(recorded.cells).every(count => Number.isSafeInteger(count) && count > 0);
  const actual = shimCountBaseline(report);
  if (valid && JSON.stringify(Object.entries(recorded.cells).sort()) === JSON.stringify(Object.entries(actual.cells).sort())) return [];
  return ['shim count baseline differs from source; run node bin/cell-lints.js --shim-update and commit bin/cell-lint-baselines/shim-counts.json'];
}
