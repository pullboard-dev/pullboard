/**
 * Where runner time goes: a pure summary of the runner-time sidecar's dispatches by purpose, and the share no item and
 * purpose can be charged for [C7,#8184]. A dispatch is attributed when it names both an item and a kind; any other is
 * unattributed, whatever it named.
 */

/** Minutes as a number rounded to three places, so a sum of many lines carries no float noise. */
function rounded(minutes) {
  return Math.round(minutes * 1000) / 1000;
}

/**
 * Sum the dispatches by purpose (their kind) and set aside the unattributed ones.
 *
 * @param {{ item: string, kind: string, minutes: number }[]} dispatches - Sidecar lines, as readRunnerTime returns them.
 * @returns {{ dispatches: number, minutes: number, unattributed: { dispatches: number, minutes: number }, unattributedShare: number|null,
 *   byPurpose: { purpose: string, dispatches: number, minutes: number }[] }} The share is 0 through 1, or null when no minutes ran.
 */
export function runnerTimeSummary(dispatches) {
  const purposes = new Map();
  const unattributed = { dispatches: 0, minutes: 0 };
  let minutes = 0;
  for (const { item, kind, minutes: spent } of dispatches) {
    minutes += spent;
    if (item === '' || kind === '') {
      unattributed.dispatches += 1;
      unattributed.minutes += spent;
      continue;
    }
    const row = purposes.get(kind) ?? { purpose: kind, dispatches: 0, minutes: 0 };
    row.dispatches += 1;
    row.minutes += spent;
    purposes.set(kind, row);
  }
  return { dispatches: dispatches.length, minutes: rounded(minutes),
    unattributed: { dispatches: unattributed.dispatches, minutes: rounded(unattributed.minutes) },
    unattributedShare: minutes > 0 ? unattributed.minutes / minutes : null,
    byPurpose: [...purposes.values()].map(row => ({ ...row, minutes: rounded(row.minutes) })).sort((a, b) => b.minutes - a.minutes || a.purpose.localeCompare(b.purpose)) };
}

/** A share of 0 through 1 as a percentage with one decimal. */
function percent(share) {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * The printable lines of a runner-time summary: minutes by purpose, then the unattributed share.
 *
 * @param {ReturnType<typeof runnerTimeSummary>} summary
 * @returns {string[]}
 */
export function runnerTimeLines(summary) {
  if (!summary.dispatches) return ['runner time: no runner dispatch recorded in this window'];
  const lines = [`runner time by purpose (${summary.dispatches} dispatches, ${summary.minutes.toFixed(1)} minutes):`];
  for (const row of summary.byPurpose) lines.push(`  ${row.purpose.padEnd(18)} ${String(row.dispatches).padStart(5)} dispatches ${row.minutes.toFixed(1).padStart(8)} min`);
  lines.push(`  ${'unattributed'.padEnd(18)} ${String(summary.unattributed.dispatches).padStart(5)} dispatches ${summary.unattributed.minutes.toFixed(1).padStart(8)} min (no item or no kind named)`);
  lines.push(`unattributed share of runner minutes: ${summary.unattributedShare === null ? 'n/a' : percent(summary.unattributedShare)}`);
  return lines;
}
