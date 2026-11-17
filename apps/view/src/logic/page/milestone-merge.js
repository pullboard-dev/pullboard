/**
 * With state.milestoneDelta on, a milestone's forecast (estimate, window, reason) is no longer sent: the server leaves those
 * fields out of its change check, so a pace that moved alone sends no milestone. The page derives them here from the milestone's
 * own count left and the board-wide pace it already holds, with the roadmap's own forecast function, so the merged milestone
 * reads as a full state would [C7,#9849]. A milestone with no summary or no pace is returned as it came.
 *
 * Self-contained (the forecast function is passed in) so the page embeds it as source.
 *
 * @param {{ milestones?: object[] }} state - The state after a delta was applied.
 * @param {(left: number, pace: object, shipped: boolean) => object} forecast - The roadmap's milestoneForecast.
 * @returns {object} The state with each milestone's forecast derived; the same state when it holds no milestones.
 */
export function deriveMilestoneForecasts(state, forecast) {
  if (!Array.isArray(state?.milestones)) return state;
  const milestones = state.milestones.map((milestone) => {
    const summary = milestone?.summary;
    if (!summary || !summary.pace || !Number.isFinite(summary.left)) return milestone;
    return { ...milestone, summary: { ...summary, ...forecast(summary.left, summary.pace, Boolean(milestone.shipped)) } };
  });
  return { ...state, milestones };
}
