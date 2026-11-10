/**
 * Refuse only shims the candidate adds over current main, naming each file; a newly introduced physical shim
 * needs an exact first move, even during advisory migration [C7,CD64].
 * Both counts are computed at check time from main's and the candidate's source: no committed snapshot is
 * compared, so main's own landed shims can never refuse an unrelated item.
 */
export function shimCountProblems({ before, after, beforeInventory, afterInventory }) {
  const existing = new Set(before.metrics.shims.findings.map(row => row.key));
  const problems = [];
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
