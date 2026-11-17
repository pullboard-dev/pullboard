/** Marker rows for further ecosystems: each language is one row of data, not more detection code [#3707,C7]. */

/**
 * Ruby: a Gemfile alone proves nothing, so the command reads what the repo holds and answers '' (no match) when it holds neither a spec nor a Rake test setup.
 *
 * @param {string[]} names directory entry names of the repo root
 * @returns {string}
 */
function rubyCommand(names) {
  if (names.includes('.rspec') || names.includes('spec')) return 'bundle exec rspec';
  if (names.includes('Rakefile') && names.includes('test')) return 'bundle exec rake test';
  return '';
}

/** The extra ecosystem rows, in alphabetical order by language; a row's command or tests may be a function of the root's entry names. */
export const LANGUAGE_ROWS = Object.freeze([
  Object.freeze({
    language: 'ruby',
    markers: Object.freeze(['Gemfile']),
    command: rubyCommand,
    tests: (names) => (rubyCommand(names) === 'bundle exec rspec' ? ['**/*_spec.rb'] : ['**/test_*.rb', '**/*_test.rb']),
  }),
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
  if (typeof row.command === 'function' && row.command(names) === '') return false;
  if (!row.requires) return true;
  return contents(row.requires.file)?.includes(row.requires.includes) ?? false;
}
