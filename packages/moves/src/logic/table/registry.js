/** The registry rule for the moves cell's generated table tests: each carries a stable ID and one record naming the table row it owns [C7,U148,#8392]. */

const TITLE = /^test\('((?:[^'\\]|\\.)*)'/gmu;
const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/u;
const MOVE = /^[a-z]+:(\*|[a-z][a-z0-9-]*)$/u;

/**
 * Pick this registry's own ID from a test title's leading ID chain. A title may carry several stable IDs, the cell registry's first
 * (`moves.<file>.<slug>`, named for the test file) and then this registry's (`moves.<table>.<name>`), so the reader skips an ID in the file's own cell namespace.
 * When the title carries only the cell-namespace ID, that one is this registry's too. Why: both registries must see their own ID without renaming either's records.
 *
 * @param {string} title the test title
 * @param {string} file the test file name, whose part before the first dot names the cell-namespace ID
 * @returns {string} the chosen ID, or the first token when the title starts with no ID
 */
function ownId(title, file) {
  const chain = [];
  for (const token of title.split(': ')) { if (!ID.test(token)) break; chain.push(token); }
  if (chain.length === 0) return title.split(': ')[0];
  const cellPrefix = `moves.${file.split('.')[0]}.`;
  return chain.find((id) => !id.startsWith(cellPrefix)) ?? chain[0];
}

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
      const id = ownId(match[1], file);
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

/**
 * Report each move-table row that a registry record outside the moves cell also claims, so a journey's move-rule assertion shows up as a duplicate claim.
 * Report only: it returns findings and never refuses. Why: the table test owns the row; a second claim elsewhere is the journey assertion to remove.
 *
 * @param {{ cell: string, records: Record<string, { proves?: { move?: string } }> }[]} registries every cell's registry records, each with its cell name ("moves" is the owner)
 * @returns {{ row: string, owner: string, duplicates: string[] }[]} one finding per owned row claimed outside the moves cell, sorted by row; IDs are `<cell>:<test id>` for the outsiders
 */
export function duplicateMoveClaims(registries) {
  const owners = new Map();
  for (const { cell, records } of registries) {
    if (cell !== 'moves') continue;
    for (const [id, record] of Object.entries(records)) {
      const row = record?.proves?.move;
      if (typeof row === 'string' && MOVE.test(row) && !owners.has(row)) owners.set(row, id);
    }
  }
  const found = new Map();
  for (const { cell, records } of registries) {
    if (cell === 'moves') continue;
    for (const [id, record] of Object.entries(records)) {
      const row = record?.proves?.move;
      if (typeof row !== 'string' || !MOVE.test(row)) continue;
      const [table] = row.split(':');
      if (!owners.has(row) && !owners.has(`${table}:*`)) continue;
      found.set(row, [...(found.get(row) ?? []), `${cell}:${id}`]);
    }
  }
  return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([row, duplicates]) => {
    const table = row.split(':')[0];
    return { row, owner: owners.get(row) ?? owners.get(`${table}:*`), duplicates: duplicates.sort() };
  });
}

/**
 * Find the move-table rows no registry record owns, and the rows two records own, so every row has exactly one owning table test [C7,U148,#8393].
 * A record owns a row by naming it exactly (`<table>:<row>`); a row no record names exactly is owned by its table's one `.rows-fire` record (`<table>:*`), the test that fires every row.
 * Other `<table>:*` records prove properties across the whole table and own no row. Why: a row with no owner is untested, and a row with two owners means a duplicate claim to remove.
 *
 * @param {Record<string, string[]>} tables the row ids of each move table, by table name
 * @param {Record<string, { proves?: { move?: string } }>} records the moves cell's registry records by test ID
 * @returns {string[]} one problem per line, each naming the table, row or record; empty when every row has exactly one owner
 */
export function moveRowOwnershipProblems(tables, records) {
  const problems = [];
  for (const [table, rows] of Object.entries(tables)) {
    const exact = new Map();
    const whole = [];
    for (const [id, record] of Object.entries(records)) {
      const move = record?.proves?.move;
      if (typeof move !== 'string' || !move.startsWith(`${table}:`)) continue;
      const row = move.slice(table.length + 1);
      if (row === '*') { if (id.endsWith('.rows-fire')) whole.push(id); continue; }
      if (!rows.includes(row)) problems.push(`${table}: record ${id} names row ${row}, which the table does not have`);
      exact.set(row, [...(exact.get(row) ?? []), id]);
    }
    if (whole.length > 1) problems.push(`${table}: the whole table has two owners: ${whole.sort().join(', ')}`);
    for (const row of rows) {
      const owners = exact.get(row) ?? [];
      if (owners.length > 1) problems.push(`${table}:${row} is owned by two records: ${[...owners].sort().join(', ')}`);
      else if (owners.length === 0 && whole.length === 0) problems.push(`${table}:${row} has no record that owns it`);
    }
  }
  return problems;
}
