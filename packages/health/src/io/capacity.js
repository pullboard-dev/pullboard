/** Health names the week a recorded capacity measure worsened and the files that drove it [C7,R1,R2]. */

/** The measures a weekly capacity row holds; a rise in any of them is a worse week. */
const MEASURES = Object.freeze([
  ['conflictPressure', 'conflict pressure'],
  ['hoursInFlight', 'hours in flight'],
  ['cellsPerItem', 'cells per item'],
]);

/**
 * The newest recorded week when it worsened against the week before, as a waiting finding naming the week and its files; else none.
 * Why only the newest: a finding that outlived its week would never clear, and the next flat week is the answer to it.
 * Why a read of the board's rows here: `pullboard capacity` keeps them as `capacity.week.<ISO week>` records, one per week.
 *
 * @param {{ prepare: (sql: string) => { all: (...args: any[]) => any[] } }} db - A read connection to the board.
 * @param {number} now - The observation time in milliseconds.
 * @param {(cause: string, item: null, fields: object) => object} finding - The health finding builder.
 * @returns {object[]} Zero or one finding.
 */
export function capacityWorsenedFindings(db, now, finding) {
  const prefix = 'capacity.week.';
  const rows = db.prepare('SELECT meta_value FROM board_meta WHERE substr(meta_key, 1, ?) = ? ORDER BY meta_key').all(prefix.length, prefix).map(row => JSON.parse(row.meta_value));
  if (rows.length < 2) return [];
  const [previous, latest] = rows.slice(-2);
  const rose = MEASURES.filter(([key]) => Number.isFinite(latest[key]) && Number.isFinite(previous[key]) && latest[key] > previous[key]);
  if (!rose.length) return [];
  const files = (latest.files ?? []).map(entry => entry.file);
  return [finding('CAPACITY_WORSENED', null, {
    subject: `capacity ${latest.week}`, key: `CAPACITY_WORSENED:week:${latest.week}`, since: latest.at, now,
    title: `capacity worsened in ${latest.week}`,
    why: `${latest.week}: ${rose.map(([key, label]) => `${label} rose from ${previous[key]} to ${latest[key]}`).join('; ')} against ${previous.week}${files.length ? `; driven by ${files.join(', ')}` : ''}`,
    next: files.length ? `split or decouple ${files[0]}, the file with the most pressure, then rerun pullboard capacity` : 'read pullboard capacity --detail for what drove the week',
    owner: { role: 'coordinator', who: 'coordinator' },
    detail: { week: latest.week, previousWeek: previous.week, rose: rose.map(([key]) => ({ measure: key, from: previous[key], to: latest[key] })), files: latest.files ?? [] },
  })];
}
