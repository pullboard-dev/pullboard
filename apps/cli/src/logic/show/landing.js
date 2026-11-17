/**
 * The phases of the landing receipt that merged an item, as show prints them: one line each, in the order the runner job ran them.
 * Why: a landing's time was recorded but nothing read it, so a slow landing could not be told from a slow gate [C7,#9079].
 *
 * @param {Array<{ phase: string, ms: number }> | undefined} phases - the item's recorded landing phases; none for an item landed before they were kept.
 * @returns {string[]} none when no phase was recorded.
 */
export function landingPhaseLines(phases) {
  return (Array.isArray(phases) ? phases : []).map(row => `landing phase ${row.phase}: ${row.ms} ms`);
}
