/** The line controller's stage-to-setting fixes map, and the stored record of its last change [C7,#1099]. */

/** The window stage each line setting answers, and how far one cycle moves it; build and review are seat calls. */
const SETTING_FIXES = {
  reviewWait: { key: 'wipPerReviewer', step: 0.25 },
  mergeWait: { key: 'landingBatchSize', step: 1 },
  sendBackIdle: { key: 'takeoverMinutes', step: -5 },
};
const REASON = /^flow tune: (\S+) over target; (\S+) (-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?)$/u;

/**
 * Map each window stage to its fix: a line setting inside its range, or a seat call only the person makes.
 * Why: chooseTuning with no fixes can only name the constraint, so `flow tune --apply` had nothing to write. The ranges
 * come in as `definitions`, so this cell never copies them and never imports the queue cell.
 *
 * @param {Record<string, unknown>} lineSettings the current line setting values by key
 * @param {Record<string, { min?: number, max?: number }>} definitions the line setting ranges by key
 */
export function tuneFixes(lineSettings, definitions) {
  const fixes = { build: { needs: 'seat' }, review: { needs: 'seat' } };
  for (const [stage, { key, step }] of Object.entries(SETTING_FIXES)) {
    const value = lineSettings?.[key];
    const { min, max } = definitions?.[key] ?? {};
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) continue;
    fixes[stage] = { needs: 'setting', key, value, min, max, step };
  }
  return fixes;
}

/**
 * The reason string and numeric window that record one tuning change as a line setting event.
 * @param {{ stage: string, key: string, from: number, to: number }} choice a chooseTuning setting choice
 * @param {{ windowMinutes: number, overTargetMinutes: number, landed: number }} window the constraint window before the change
 */
export function tuneRecord(choice, window) {
  const { windowMinutes, overTargetMinutes, landed } = window;
  return {
    reason: `flow tune: ${choice.stage} over target; ${choice.key} ${choice.from} to ${choice.to}`,
    window: { windowMinutes, overTargetMinutes, landed, from: choice.from, to: choice.to },
  };
}

/** One event's decoded detail: the store keeps it as JSON text. */
function detailOf(event) {
  const raw = event?.event_detail ?? event?.detail;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

/**
 * The newest tuning change in the events, in the shape revertTuning compares, or null when none was recorded.
 * @param {object[]} events board events oldest first
 */
export function lastTuneChange(events) {
  for (let at = (events ?? []).length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event?.event_kind !== 'line_setting') continue;
    const detail = detailOf(event);
    const match = typeof detail.reason === 'string' ? REASON.exec(detail.reason) : null;
    if (!match) continue;
    const { overTargetMinutes, landed } = detail.window ?? {};
    return { stage: match[1], key: match[2], from: Number(match[3]), to: Number(match[4]), before: { overTargetMinutes, landed } };
  }
  return null;
}
