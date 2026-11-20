/**
 * A board's sidebar summary as the text the API serves at /boards/:id/summary: the view's projectSummary over a
 * build's summary state and the person's needs it carries, a few hundred bytes however large the board (#6634).
 * It is kept on the build, so a read of the same build costs nothing.
 */

/**
 * Return the cached board summary as JSON text, built once with the view's projection and kept on the entry.
 * @param {{ summary: { needs?: object[] }, summaryText?: string }} entry One cached board build; the text is kept on it.
 * @param {(state: object, needs: object[]) => object} projectSummary The view's projection, a port from the composition root.
 * @returns {string} JSON text of {version: 1, summary}.
 */
export function summaryTextOf(entry, projectSummary) {
  return entry.summaryText ??= JSON.stringify({ version: 1, summary: projectSummary(entry.summary, entry.summary.needs ?? []) });
}
