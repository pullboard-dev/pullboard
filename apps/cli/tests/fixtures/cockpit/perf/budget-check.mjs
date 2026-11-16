/** The view's four instant-feel budgets (U94) and the words a missed one fails with [N26]. */

/** The four U94 budgets; `limit` is inclusive. */
export const BUDGETS = Object.freeze({
  clickFeedback: Object.freeze({ label: 'a click shows feedback', limit: 50, unit: 'ms' }),
  tabSwitch: Object.freeze({ label: 'a tab switch draws', limit: 100, unit: 'ms' }),
  firstRows: Object.freeze({ label: 'first item rows on a warm server', limit: 1_500, unit: 'ms' }),
  firstLoadBytes: Object.freeze({ label: "the open board's first load", limit: 500 * 1024, unit: 'bytes' }),
});

/** Format one measured value in its budget's unit. */
function shown(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'never (no paint within the hang ceiling)';
  return unit === 'bytes' ? `${Math.round(value / 1024)} KB (${value} bytes)` : `${Math.round(value)} ms`;
}

/** Format a budget's limit in its unit. */
function limitOf(budget) {
  return budget.unit === 'bytes' ? `${budget.limit / 1024} KB` : `${budget.limit} ms`;
}

/**
 * Name every missed budget with its measured value, the sample that missed it, and the overshoot.
 * An unmeasured value (null) is a miss: a check that could not see the paint must not pass.
 * @param {{ clickFeedback: { worst: number|null, sample: string }, tabSwitch: { worst: number|null, sample: string },
 *   firstRows: { value: number|null }, firstLoadBytes: { value: number|null } }} report
 * @returns {string[]} One line per missed budget, empty when all four are met.
 */
export function budgetFailures(report) {
  const failures = [];
  for (const [key, budget] of Object.entries(BUDGETS)) {
    const entry = report?.[key];
    const value = entry && 'worst' in entry ? entry.worst : entry?.value;
    if (Number.isFinite(value) && value <= budget.limit) continue;
    const where = entry?.sample ? ` (${entry.sample})` : '';
    const over = Number.isFinite(value) ? `, ${shown(value - budget.limit, budget.unit)} over` : '';
    failures.push(`${budget.label} within ${limitOf(budget)}: measured ${shown(value, budget.unit)}${where}${over}`);
  }
  return failures;
}

/** Throw one error naming every missed budget, or return when the view meets all four. */
export function assertBudgets(report) {
  const failures = budgetFailures(report);
  if (failures.length) {
    const scale = report?.population ? ` on a board of ${report.population.items} items` : '';
    throw new Error(`View speed budgets missed${scale}:\n${failures.map((line) => `- ${line}`).join('\n')}`);
  }
}

/** One line per budget with its measured value, for diagnostics and the item's facts. */
export function budgetSummary(report) {
  return Object.entries(BUDGETS).map(([key, budget]) => {
    const entry = report[key];
    const value = 'worst' in entry ? entry.worst : entry.value;
    const met = Number.isFinite(value) && value <= budget.limit;
    return `${met ? 'met ' : 'MISS'} ${budget.label} within ${limitOf(budget)}: ${shown(value, budget.unit)}${entry.sample ? ` (${entry.sample})` : ''}`;
  }).join('\n');
}
