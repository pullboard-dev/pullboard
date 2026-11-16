/** One weekly capacity row: the three pressures and the files that drove them [C7,R1,R2]. */

/** How many driving files a row keeps, so a week stays one small record. */
const DRIVERS = 5;

/**
 * The ISO week a moment falls in, such as `2026-W46`, in UTC.
 * Why UTC: every machine names the same week for the same moment, so a board shared across machines keeps one row per week.
 *
 * @param {Date | string | number} when
 * @returns {string}
 */
export function isoWeek(when) {
  const day = new Date(when);
  const thursday = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const first = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return `${thursday.getUTCFullYear()}-W${String(Math.ceil(((thursday.getTime() - first) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
}

/**
 * Reduce one carrying-capacity reading to the weekly row health compares: conflict pressure (k), mean hours in flight,
 * cells per item, and the files with the most pressure. Unknown measurements stay null rather than becoming zero.
 *
 * @param {any} carrying - The reading from readCarryingCapacity.
 * @param {Date | string | number} at - When the reading was taken; it names the week.
 * @returns {{ week: string, at: string, conflictPressure: number | null, hoursInFlight: number | null, cellsPerItem: number | null, files: { file: string, pressure: number }[] }}
 */
export function capacityWeekRow(carrying, at) {
  const number = value => Number.isFinite(value) ? value : null;
  return { week: isoWeek(at), at: new Date(at).toISOString(),
    conflictPressure: number(carrying.k), hoursInFlight: number(carrying.lifetimeHours), cellsPerItem: number(carrying.cellsPerItem),
    files: (carrying.files ?? []).filter(row => Number.isFinite(row.pressure) && row.pressure > 0).slice(0, DRIVERS).map(row => ({ file: row.file, pressure: row.pressure })) };
}
