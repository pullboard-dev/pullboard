/** Runner minutes per check run and per item, from the item's recorded check receipts [C7]. */

const MS_PER_MINUTE = 60_000;

/** Minutes with one decimal place, so a 346 s run reads 5.8. */
function minutes(ms) {
  return Math.round(ms / MS_PER_MINUTE * 10) / 10;
}

/**
 * Turn an item's recorded check receipts into each check's runner minutes and the item's total per runner.
 * Why: a runner's cost is its minutes, so the report reads what each check run recorded (runner host and duration)
 * and never estimates; a check that ran with no runner recorded counts under "local".
 *
 * @param {{ id: string, kind?: string, runner?: string|null, durationMs?: number }[]} receipts - The item's proof receipts, as proofReceipts returns them.
 * @returns {{ checks: { id: string, runner: string, ms: number, minutes: number }[], perRunner: { runner: string, ms: number, minutes: number, checks: number }[], totalMs: number, totalMinutes: number }}
 */
export function runnerMinutes(receipts) {
  const checks = receipts
    .filter(receipt => (receipt.kind ?? 'check') === 'check' && Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0)
    .map(receipt => ({ id: receipt.id, runner: receipt.runner || 'local', ms: receipt.durationMs, minutes: minutes(receipt.durationMs) }));
  const by = new Map();
  for (const check of checks) {
    const row = by.get(check.runner) ?? { runner: check.runner, ms: 0, checks: 0 };
    row.ms += check.ms;
    row.checks += 1;
    by.set(check.runner, row);
  }
  const perRunner = [...by.values()].map(row => ({ ...row, minutes: minutes(row.ms) })).sort((a, b) => b.ms - a.ms || a.runner.localeCompare(b.runner));
  const totalMs = checks.reduce((sum, check) => sum + check.ms, 0);
  return { checks, perRunner, totalMs, totalMinutes: minutes(totalMs) };
}
