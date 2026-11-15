/** Decide, from mutation reports, whether a delete-tagged journey really is covered by the cells that cite its spec ids, purely [C7]. */

const CELL = /^((?:packages|apps)\/[^/]+)\/tests?\//u;

/**
 * The cells whose own tests cite the spec ids a journey cites, most shared ids first.
 * Why: the delete tag rests on those cells proving the same ids, so their mutation score is the evidence to check.
 *
 * @param {{ file: string, kind: string, specs: string[] }[]} rows manifest rows
 * @param {{ specs: string[] }} journey the journey row
 * @param {number} [limit] most cells to return
 * @returns {{ cell: string, shared: number }[]}
 */
export function coveringCells(rows, journey, limit = 3) {
  const wanted = new Set(journey.specs);
  const shared = new Map();
  for (const row of rows) {
    const cell = row.kind === 'journey' ? null : CELL.exec(row.file)?.[1];
    if (!cell) continue;
    const ids = new Set(row.specs.filter(id => wanted.has(id)));
    if (ids.size) shared.set(cell, new Set([...(shared.get(cell) ?? []), ...ids]));
  }
  return [...shared].map(([cell, ids]) => ({ cell, shared: ids.size })).sort((a, b) => b.shared - a.shared || (a.cell < b.cell ? -1 : 1)).slice(0, limit);
}

/**
 * One cell's mutation score with and without a journey, read from one report that ran the journey beside the cell's tests.
 * Why one report: a fault the journey alone caught is the proof that deleting it loses coverage.
 *
 * @param {string} journey the journey's path, as listed in the report
 * @param {{ faults: { caughtBy?: string[] }[] }} report a mutate report
 * @returns {{ seeded: number, with: number, without: number, dropped: boolean, blind: boolean, skipped: number, capped: number }} blind is true when the journey failed before any fault, so its score says nothing
 */
export function scoreWithAndWithout(journey, report) {
  const faults = report.faults ?? [];
  const caughtBy = fault => fault.caughtBy ?? [];
  const withJourney = faults.filter(fault => caughtBy(fault).length).length;
  const without = faults.filter(fault => caughtBy(fault).some(file => file !== journey)).length;
  return { seeded: faults.length, with: withJourney, without, dropped: without < withJourney, blind: (report.redBefore ?? []).includes(journey), skipped: report.skipped ?? 0, capped: report.capped ?? 0 };
}

/**
 * The verdict for one delete-tagged journey over the reports of its covering cells.
 * Retagged convert when any covering cell's score drops without it; held when none drops; unmeasured when no fault was seeded anywhere.
 *
 * @param {string} journey journey path
 * @param {{ cell: string, report: object }[]} reports one mutate report per covering cell
 * @returns {{ file: string, cells: object[], verdict: 'convert'|'hold'|'unmeasured', because: string }}
 */
export function judgeJourney(journey, reports) {
  const cells = reports.map(({ cell, report }) => ({ cell, ...scoreWithAndWithout(journey, report) }));
  const dropped = cells.filter(row => row.dropped);
  if (dropped.length) return { file: journey, cells, verdict: 'convert', because: `without it ${dropped.map(row => `${row.cell} falls from ${row.with} to ${row.without} of ${row.seeded} faults caught`).join('; ')}` };
  if (!cells.some(row => row.seeded && !row.blind)) return { file: journey, cells, verdict: 'unmeasured', because: cells.some(row => row.blind) ? 'it fails before any fault is seeded, so its coverage cannot be measured' : cells.length ? 'no fault was seeded in its covering cells' : 'no cell test cites its spec ids' };
  return { file: journey, cells, verdict: 'hold', because: 'no covering cell scores lower without it' };
}

/**
 * Retag the journeys the check found to lose coverage; every other row is returned as it was.
 *
 * @param {object[]} rows manifest rows
 * @param {{ file: string, verdict: string, because: string }[]} verdicts
 * @returns {object[]}
 */
export function retagChecked(rows, verdicts) {
  const converts = new Map(verdicts.filter(item => item.verdict === 'convert').map(item => [item.file, item.because]));
  return rows.map(row => (row.tag === 'delete' && converts.has(row.file) ? { ...row, tag: 'convert', tagBecause: `a covering cell's mutation score drops without it: ${converts.get(row.file)}` } : row));
}

/**
 * The share of sampled delete tags that hold, with the counts behind it.
 *
 * @param {{ verdict: string }[]} verdicts
 * @returns {{ sampled: number, held: number, converted: number, unmeasured: number, share: number }} share is held over sampled, 0 to 1
 */
export function holdShare(verdicts) {
  const count = verdict => verdicts.filter(item => item.verdict === verdict).length;
  const sampled = verdicts.length;
  return { sampled, held: count('hold'), converted: count('convert'), unmeasured: count('unmeasured'), share: sampled ? count('hold') / sampled : 0 };
}
