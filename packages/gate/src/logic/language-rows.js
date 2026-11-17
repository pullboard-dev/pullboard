/** Marker rows for further ecosystems: each language is one row of data, not more detection code [#3707,C7]. */

/**
 * The extra ecosystem rows, in alphabetical order by language; a row is added by one entry and one test, with no new detection code.
 * A command function that returns '' means the row does not apply after all, and the language is left out [#10117,C7].
 */
export const LANGUAGE_ROWS = Object.freeze([
  { language: 'haskell', markers: ['stack.yaml', 'cabal.project'], pattern: /\.cabal$/u, command: (names) => (names.includes('stack.yaml') ? 'stack test' : 'cabal test'), tests: ['**/test/**/*.hs', '**/*Spec.hs'] },
  { language: 'perl', markers: ['cpanfile', 'Makefile.PL', 'Build.PL', 'dist.ini'], command: (names) => (names.includes('t') ? 'prove -lr t' : ''), tests: ['t/**/*.t'] },
  { language: 'sbt', markers: ['build.sbt'], command: 'sbt test', tests: ['**/src/test/scala/**/*.scala'] },
]);

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
