/** Choose the line controller's one change per cycle, or a request to the person; reads no board [C7,#1099]. */

/** The constraint of a window: the stage that held the line, and its minutes over target. */
const stageOf = window => window?.constraint?.stage ?? null;

/**
 * Pick at most one line setting change, inside its range, or a request to the person.
 * Why: a change needs the same constraint in two consecutive windows, so one noisy window never moves the line, and a
 * fix that needs a seat, a machine or a scope call is the person's to make, never a setting.
 *
 * `fixes` maps a stage to its fix: { needs: 'setting', key, value, min, max, step } for a line setting, or
 * { needs: 'seat' | 'machine' | 'scope' } for a call only the person makes.
 *
 * @param {{ constraint: { stage: string, overTargetMinutes: number } | null }[]} windows oldest first; the last two are compared
 * @param {Record<string, { needs: string, key?: string, value?: number, min?: number, max?: number, step?: number }>} fixes
 * @returns {{ kind: 'none' } | { kind: 'setting', stage: string, key: string, from: number, to: number } | { kind: 'request', stage: string, needs: string }}
 */
export function chooseTuning(windows, fixes) {
  const [earlier, latest] = (windows ?? []).slice(-2);
  const stage = stageOf(latest);
  if (!earlier || !stage || stageOf(earlier) !== stage) return { kind: 'none' };
  const fix = fixes?.[stage];
  if (!fix) return { kind: 'none' };
  if (fix.needs !== 'setting') return { kind: 'request', stage, needs: fix.needs };
  const to = Math.min(fix.max, Math.max(fix.min, fix.value + fix.step));
  return to === fix.value ? { kind: 'none' } : { kind: 'setting', stage, key: fix.key, from: fix.value, to };
}

/** The constraint's hours over target per landed item in a window; no landed item with minutes over is infinitely worse. */
function hoursPerItem({ overTargetMinutes, landed }) {
  if (!(overTargetMinutes > 0)) return 0;
  return landed > 0 ? overTargetMinutes / 60 / landed : Infinity;
}

/**
 * Whether the next cycle reverts a change: yes when the constraint's hours over target per landed item rose after it.
 * Why: a change must pay for itself on the board's own numbers, or it is undone before it compounds.
 *
 * @param {object | null} change the change the last cycle made
 * @param {{ overTargetMinutes: number, landed: number }} before the constraint's window before the change
 * @param {{ overTargetMinutes: number, landed: number }} after the constraint's window after the change
 * @returns {'revert' | 'keep'}
 */
export function revertTuning(change, before, after) {
  return change && hoursPerItem(after) > hoursPerItem(before) ? 'revert' : 'keep';
}
