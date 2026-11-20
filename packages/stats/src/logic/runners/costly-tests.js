/** Test files that failed gates for many unrelated items, with the runner minutes they cost [C7]. */

const MS_PER_MINUTE = 60_000;

/** Minutes with one decimal place, as runnerMinutes reports them. */
function minutes(ms) {
  return Math.round(ms / MS_PER_MINUTE * 10) / 10;
}

/**
 * Group gate fail rows by test file and list each file that failed for minItems or more unrelated items.
 * Why: a test file that fails for items that never touched it costs runner time to every one of them, so the board names it instead of the coordinator finding it by hand.
 * An item is unrelated when its own file list does not name the test file; a row with no file counts under its command.
 *
 * @param {{ file?: string|null, item: number|string, itemFiles?: string[], command?: string, at: number, ms?: number }[]} rows - Failed gate rows from the board's per-file test results.
 * @param {{ minItems?: number, since?: number }} [options] - minItems is the fewest unrelated items to list a file (default 5); since leaves out rows before that time in ms.
 * @returns {{ file: string, items: (number|string)[], runs: number, runnerMinutes: number }[]} Highest runner-minutes first.
 */
export function costlyTests(rows, { minItems = 5, since = 0 } = {}) {
  const by = new Map();
  for (const row of rows) {
    if (row.at < since) continue;
    const key = row.file || row.command;
    if (!key) continue;
    if ((row.itemFiles ?? []).includes(key)) continue;
    const entry = by.get(key) ?? { items: new Set(), runs: 0, ms: 0 };
    entry.items.add(row.item);
    entry.runs += 1;
    entry.ms += Number.isFinite(row.ms) && row.ms > 0 ? row.ms : 0;
    by.set(key, entry);
  }
  return [...by.entries()]
    .filter(([, entry]) => entry.items.size >= minItems)
    .map(([file, entry]) => ({ file, items: [...entry.items].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })), runs: entry.runs, runnerMinutes: minutes(entry.ms), ms: entry.ms }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file))
    .map(({ ms, ...row }) => row);
}
