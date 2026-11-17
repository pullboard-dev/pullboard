/** Marker rows for further ecosystems: each language is one row of data, not more detection code [#3707,C7]. */

/** The extra ecosystem rows, in detection order; starts empty so behaviour is unchanged until a row is added. */
export const LANGUAGE_ROWS = Object.freeze([]);

/**
 * Whether one row's ecosystem is present in a repo root, judged only from names and file contents.
 * Why: a table of simple rows lets each language land as one row and one test, with no new detection code.
 *
 * @param {{ markers?: string[], pattern?: RegExp, requires?: { file: string, includes: string } }} row
 * @param {string[]} names directory entry names of the repo root
 * @param {(name: string) => string | null} contents reads one root file, null when absent
 * @returns {boolean}
 */
export function rowMatches(row, names, contents) {
  const hit = (row.markers ?? []).some((marker) => names.includes(marker))
    || (row.pattern instanceof RegExp && names.some((name) => new RegExp(row.pattern.source, row.pattern.flags.replace(/[gy]/gu, '')).test(name)));
  if (!hit) return false;
  if (!row.requires) return true;
  return contents(row.requires.file)?.includes(row.requires.includes) ?? false;
}
