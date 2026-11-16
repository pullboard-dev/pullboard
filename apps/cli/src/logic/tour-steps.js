/** How the tour labels and ranks the commands it times, so a slow tour says where its time went [N10]. */

/**
 * Arguments as a person would type them.
 *
 * @param {string[]} args
 * @returns {string}
 */
export const typed = (args) => args.map((arg) => (/[\s"'$|()]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');

/**
 * The three slowest commands the tour ran, with their times, so a slow tour says where its time went (N10).
 *
 * @param {{ label: string, ms: number }[]} timings
 * @returns {string}
 */
export function slowestSteps(timings) {
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 3);
  return `slowest steps: ${slowest.map(({ label, ms }) => `${label} ${Math.round(ms)} ms`).join('; ')}`;
}
