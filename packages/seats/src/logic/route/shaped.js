/** Name strong items that a light seat can build from their shape alone [C7,#2975]. */

/** Most brief files a light-shaped item may name. */
export const LIGHT_SHAPE_BRIEF_FILES = 2;

/**
 * True when a strong item is shaped like light work: one criterion clause, a check naming exactly one
 * test file, and at most two files in its brief. Pure: reads only the fields of `entry`, never the board.
 * Why text matching: board entries carry the criterion, check and brief as plain strings.
 *
 * @param {{ item_criterion?: string | null, item_check?: string | null, item_brief?: string | null }} entry
 * @returns {boolean}
 */
export function lightShaped(entry) {
  const clauses = new Set(String(entry?.item_criterion ?? '').match(/(?:^|\s)\d+\. /g)?.map((m) => m.trim()));
  if (clauses.size !== 1) return false;
  const checkFiles = new Set(String(entry?.item_check ?? '').match(/[\w./-]+\.js\b/g)?.filter((f) => f !== 'tests.js' && /(?:^|[/.-])tests?(?:[/.-]|$)/.test(f)));
  if (checkFiles.size !== 1) return false;
  const briefFiles = new Set(String(entry?.item_brief ?? '').match(/[\w./-]+\.(?:js|md|json)\b/g));
  return briefFiles.size <= LIGHT_SHAPE_BRIEF_FILES;
}
