/** The registry rule for the moves cell's generated table tests: each carries a stable ID and one record naming the table row it owns [C7,U148,#8392]. */

const TITLE = /^test\('((?:[^'\\]|\\.)*)'/gmu;
const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/u;
const MOVE = /^[a-z]+:(\*|[a-z][a-z0-9-]*)$/u;

/**
 * Find what is wrong with the registry of generated table tests: a test whose title does not start with a stable ID,
 * an ID with no record, a record whose proves.move is not `<table>:<row>` (or `<table>:*` for the whole table),
 * a record naming no test, and an ID used by two tests.
 *
 * @param {{ file: string, source: string }[]} files the generated table test files with their text
 * @param {Record<string, { proves?: { move?: string } }>} records the registry records by test ID
 * @returns {string[]} one problem per line, each naming the file or record; empty when the registry is whole
 */
export function tableTestRegistryProblems(files, records) {
  const problems = [];
  const seen = new Set();
  for (const { file, source } of files) {
    for (const match of source.matchAll(TITLE)) {
      const id = match[1].split(': ')[0];
      if (!ID.test(id)) { problems.push(`${file}: test "${match[1].slice(0, 40)}" has no stable ID before its first colon`); continue; }
      if (seen.has(id)) problems.push(`${file}: ID ${id} is used by two tests`);
      seen.add(id);
      const record = records[id];
      if (!record) problems.push(`${file}: ${id} has no registry record`);
      else if (!MOVE.test(record.proves?.move ?? '')) problems.push(`${file}: ${id} record does not name the table row it owns in proves.move`);
    }
  }
  for (const id of Object.keys(records)) if (!seen.has(id)) problems.push(`registry.json: record ${id} names no generated test`);
  return problems;
}
