/** Classify tracked test inputs by their first owned production dependencies, and move a cell's tests home [C7,CD64]. */
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';

/** Build deterministic ownership for old paths, moved bodies, and existing cell roots. */
function cellFor(file, plan) {
  for (const cell of plan.cells) {
    if (cell.paths.some(([old, moved]) => file === old || file === moved)) return cell.name;
  }
  return plan.cells.find(cell => file.startsWith(`${cell.root}/`))?.name ?? null;
}

/** Test helpers are traversed; the first production cell stops each branch of the graph. */
function classify(file, inventory, plan) {
  if (!/\.[cm]?js$/u.test(file)) return { file, kind: 'undecidable', reason: 'not a JavaScript module' };
  if (!inventory.files.has(file)) return { file, kind: 'undecidable', reason: 'tracked file is unavailable or not regular' };
  const pending = [file], seen = new Set(), cells = new Set(), reasons = new Set();
  const unknown = new Map();
  for (const row of inventory.unknown) {
    const rows = unknown.get(row.file) ?? [];
    rows.push(row.reason); unknown.set(row.file, rows);
  }
  while (pending.length) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const reason of unknown.get(current) ?? []) reasons.add(reason);
    for (const edge of inventory.edges.get(current) ?? []) {
      const target = edge.target;
      if (!inventory.files.has(target)) { reasons.add(`missing input ${target}`); continue; }
      const testInput = target.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(target);
      if (testInput) pending.push(target);
      else {
        const owner = cellFor(target, plan);
        if (owner) cells.add(owner);
        else reasons.add(`unowned input ${target}`);
      }
    }
  }
  const ordered = [...cells].sort();
  if (reasons.size) return { file, kind: 'undecidable', reason: [...reasons].sort().join('; '), cells: ordered };
  if (ordered.length === 1) return { file, kind: 'cell', cell: ordered[0] };
  if (ordered.length > 1) return { file, kind: 'journey', cells: ordered };
  return { file, kind: 'undecidable', reason: 'no owned production dependency' };
}

/** Classify every supplied tracked test/ path and docs test in stable path order. */
export function classifyTestFiles(tracked, inventory, plan) {
  return [...new Set(tracked)].filter(file => file.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(file))
    .sort().map(file => classify(file, inventory, plan));
}

/** Name a classified row's home: its cell, its journey's cells, or why it is unknown. */
function home(row) {
  if (row.kind === 'cell') return `cell ${row.cell}`;
  if (row.kind === 'journey') return `journey ${row.cells.join(',')}`;
  return `unknown ${row.reason}`;
}

/** Compare two strings by code unit so the report never depends on the locale. */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render the --place-tests report: one line per test file or docs check with its home, in path order,
 * then how many files each plan cell gets (zero included), the journey count and the unknown count [C7,CD64].
 */
export function placementReport(rows, cellNames = []) {
  const lines = [...rows].sort((a, b) => byCodeUnit(a.file, b.file)).map(row => `${row.file}\t${home(row)}`);
  const perCell = new Map([...new Set(cellNames)].map(name => [name, 0]));
  for (const row of rows) if (row.kind === 'cell') perCell.set(row.cell, (perCell.get(row.cell) ?? 0) + 1);
  for (const [name, count] of [...perCell].sort(([a], [b]) => byCodeUnit(a, b))) lines.push(`files for cell ${name}: ${count}`);
  lines.push(`journeys: ${rows.filter(row => row.kind === 'journey').length}`);
  lines.push(`unknown: ${rows.filter(row => row.kind !== 'cell' && row.kind !== 'journey').length}`);
  lines.push(`total: ${rows.length}`);
  return lines;
}

/** Classify every tracked test file and docs check in a checkout and render the placement report. */
export function placeTests(tracked, inventory, plan) {
  return placementReport(classifyTestFiles(tracked, inventory, plan), plan.cells.map(cell => cell.name));
}

/** Where a cell's test file lives after the move: packages/<cell>/tests/ (apps/<name>/tests/ for an app), keeping its path below test/. */
export function testHome(cell, file) {
  return `${cell.root}/tests/${file.startsWith('test/') ? file.slice('test/'.length) : file}`;
}

/** A repository-relative path with no traversal, absolute root, backslash or control character. */
function safePath(file) {
  return typeof file === 'string' && file !== '' && !/[\\\x00-\x1f\x7f]/u.test(file) && !file.startsWith('/')
    && file.split('/').every(part => part && part !== '.' && part !== '..');
}

/** The relative import specifier from `file` to `target`. */
function specifierFrom(file, target) {
  const relative = posix.relative(posix.dirname(file), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * The plain quoted import, re-export, dynamic import and require specifiers of a module, the literals it reads its own
 * location through, and whether it reads its own location any other way. `lex` is the kernel lexer, handed in by the caller
 * so this root module adds no cross-cell import. An own-location literal is the path in new URL(literal, import.meta.url), or
 * the first path after import.meta.dirname in join(...) or resolve(...); a template counts by its static part up to the last
 * slash before its first substitution. Any other import.meta, __dirname or __filename read leaves `located` true [C7,CD64].
 */
function importLiterals(source, lex) {
  const info = lex(source);
  const literals = info.strings.filter(row => (source[row.start] === "'" || source[row.start] === '"') && row.end - row.start === row.text.length + 2
    && /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*$/u.test(info.code.slice(Math.max(0, row.start - 40), row.start)));
  const reads = [...info.code.matchAll(/\bimport\s*\.\s*meta\b|\b__dirname\b|\b__filename\b/gu)].map(match => match.index);
  const covered = new Set(), own = [];
  for (const row of info.strings) {
    if (row.end - row.start !== row.text.length + 2) continue;
    const before = info.code.slice(Math.max(0, row.start - 80), row.start), after = info.code.slice(row.end, row.end + 40);
    const url = /new\s+URL\(\s*$/u.test(before) && /^\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*\)/u.exec(after);
    const dir = /\b(?:join|resolve)\(\s*(import\s*\.\s*meta)\s*\.\s*dirname\s*,\s*$/u.exec(before);
    if (!url && !dir) continue;
    const prefix = row.text.includes('${') ? row.text.slice(0, row.text.indexOf('${')) : row.text;
    if (row.text.includes('${') && !prefix.includes('/')) continue;
    covered.add(url ? row.end + after.indexOf('import') : row.start - before.length + dir.index + dir[0].indexOf('import'));
    own.push(row);
  }
  return { literals, own, located: reads.some(at => !covered.has(at)) };
}

/** The path part of an own-location literal and the text kept after it: a template keeps everything from its last static slash. */
function ownPath(text) {
  if (!text.includes('${')) return { path: text.replace(/\/+$/u, ''), rest: text.endsWith('/') && text !== '/' ? '/' : '' };
  const prefix = text.slice(0, text.indexOf('${')), cut = prefix.lastIndexOf('/');
  return { path: prefix.slice(0, cut), rest: text.slice(cut) };
}

/**
 * Rewrite the own-location literals of a file read at `from` and written at `to` so each still names the same tracked file or
 * folder, following a moved target to its home; `missing` names a literal whose target is not tracked.
 */
function repointOwn(source, rows, from, to, moved, exists) {
  let out = '', at = 0;
  const changes = [], missing = [];
  for (const row of [...rows].sort((a, b) => a.start - b.start)) {
    const { path, rest } = ownPath(row.text);
    const target = posix.normalize(posix.join(posix.dirname(from), path || '.'));
    if (target.startsWith('../') || !exists(target)) { missing.push(row.text); continue; }
    const relative = posix.relative(posix.dirname(to), moved.get(target) ?? target) || '.';
    const next = (relative.startsWith('.') ? relative : `./${relative}`) + rest;
    if (next === row.text) continue;
    out += source.slice(at, row.start + 1) + next;
    at = row.end - 1;
    changes.push(`${row.text} -> ${next}`);
  }
  return { source: out + source.slice(at), changes, missing };
}

/**
 * The committed list of files that name test paths as data. A move rewrites an exact quoted moved path in them and nothing else.
 * View roles and policy belong to the view lane and are not listed, so a test they name is moved by that lane [C7,CD64].
 */
export const TEST_PATH_TABLES_FILE = 'bin/checks/test-path-tables.json';

/** The declared table paths, read from the inventory; an absent or malformed list declares none. */
function testPathTables(inventory) {
  try { const list = JSON.parse(inventory.files.get(TEST_PATH_TABLES_FILE)?.toString('utf8') ?? '[]'); return Array.isArray(list) ? list.filter(path => typeof path === 'string') : []; }
  catch { return []; }
}

/** Replace each exact quoted moved path in a table's text; `count` is how many quoted paths changed. */
function repointTable(source, moved) {
  let count = 0;
  const out = source.replace(/(['"`])([^'"`\\\r\n]+)\1/gu, (whole, quote, text) => {
    if (!moved.has(text)) return whole;
    count++;
    return quote + moved.get(text) + quote;
  });
  return { source: out, count };
}

/**
 * Rewrite only the relative import specifiers of `source`, read at `from` and written at `to`, so each still names its target
 * after the moves. Bodies are copied byte for byte; `hits` counts specifiers that name a moved file, `missing` the unresolvable ones.
 */
function repoint(source, from, to, moved, exists, lex) {
  const changes = [], missing = [];
  let out = '', at = 0, hits = 0;
  for (const row of importLiterals(source, lex).literals) {
    if (!row.text.startsWith('./') && !row.text.startsWith('../')) continue;
    const target = posix.normalize(posix.join(posix.dirname(from), row.text));
    if (target.startsWith('../') || !exists(target)) { missing.push(row.text); continue; }
    if (moved.has(target)) hits++;
    else if (from === to) continue;
    const next = specifierFrom(to, moved.get(target) ?? target);
    if (next === row.text) continue;
    out += source.slice(at, row.start + 1) + next;
    at = row.end - 1;
    changes.push(`${row.text} -> ${next}`);
  }
  return { source: out + source.slice(at), changes, missing, hits };
}

/**
 * Plan moving one cell's classified tests to its home, repointing import specifiers only [C7,CD64]. With no paths it takes every
 * file the classifier gives that cell. It refuses, naming each case, an unknown cell, an unsafe path, a path that is not this cell's
 * test, a taken home, a file that reads its own location, an unresolvable relative import, and an importer it cannot repoint.
 * A path already at its home is reported and skipped, so a second run is a no-op. A refusal comes back as `refused: { code, message }`
 * for the caller to raise; `lex` is the kernel lexer the caller hands in.
 */
export function planTestMove({ tracked, inventory, plan, cell: name, paths = [], lex }) {
  const cell = plan.cells.find(row => row.name === name);
  if (!cell) return { refused: { code: 'CELLS_TESTS_UNKNOWN', message: `unknown cell ${JSON.stringify(name ?? '')}; name a cell from bin/cells-plan.json: node bin/cells-plan.js --move-tests <cell> [<path>...]` } };
  const unsafe = paths.filter(file => !safePath(file));
  if (unsafe.length) return { refused: { code: 'CELLS_TESTS_UNSAFE', message: `unsafe path ${unsafe.map(file => JSON.stringify(file)).join(', ')}; name repository-relative test files; nothing moved` } };
  const listed = new Set(tracked), exists = file => listed.has(file);
  const rows = new Map(classifyTestFiles(tracked, inventory, plan).map(row => [row.file, row]));
  const wanted = paths.length ? [...new Set(paths)].sort(byCodeUnit)
    : [...rows.values()].filter(row => row.kind === 'cell' && row.cell === cell.name).map(row => row.file);
  const already = [], refused = [], moved = new Map();
  for (const file of wanted) {
    const row = rows.get(file);
    if (!row && !listed.has(file) && listed.has(testHome(cell, file))) already.push(file);
    else if (!row) refused.push(`unknown path ${file} (not a tracked test file or docs check)`);
    else if (row.kind !== 'cell' || row.cell !== cell.name) refused.push(`unknown path ${file} (${home(row)}, not cell ${cell.name})`);
    else if (listed.has(testHome(cell, file))) refused.push(`${file} (its home ${testHome(cell, file)} is taken)`);
    else moved.set(file, testHome(cell, file));
  }
  const writes = [];
  const folder = path => listed.has(path) || path === '.' || tracked.some(file => file.startsWith(`${path}/`));
  for (const [file, to] of moved) {
    const source = inventory.files.get(file).toString('utf8');
    const read = importLiterals(source, lex);
    if (read.located) { refused.push(`unsafe path ${file} (reads paths relative to its own location; move it by hand)`); continue; }
    const result = repoint(source, file, to, moved, exists, lex);
    if (result.missing.length) { refused.push(`unsafe path ${file} (unknown import ${result.missing.join(', ')})`); continue; }
    // Own-location literals sit outside the import literals, so they are rewritten on the repointed text at their own offsets.
    const own = repointOwn(source, read.own, file, to, moved, folder);
    if (own.missing.length) { refused.push(`unsafe path ${file} (unknown own-location path ${own.missing.join(', ')})`); continue; }
    const merged = own.changes.length ? repoint(own.source, file, to, moved, exists, lex) : result;
    const changes = [...result.changes, ...own.changes];
    if (changes.length) writes.push({ file: to, source: merged.source, changes });
  }
  const importers = [...inventory.edges].filter(([file, edges]) => !moved.has(file) && edges.some(edge => moved.has(edge.target)))
    .map(([file]) => file).sort(byCodeUnit);
  for (const file of importers) {
    const bytes = inventory.files.get(file), result = bytes && repoint(bytes.toString('utf8'), file, file, moved, exists, lex);
    if (!result?.hits) refused.push(`unsafe path ${file} (imports a moved test without a relative specifier)`);
    else if (result.changes.length) writes.push({ file, source: result.source, changes: result.changes });
  }
  if (refused.length) return { refused: { code: 'CELLS_TESTS_UNSAFE', message: `refusing to move tests for ${cell.name}: ${refused.join('; ')}; nothing moved` } };
  for (const table of testPathTables(inventory)) {
    const home = moved.get(table) ?? table, pending = writes.find(write => write.file === home);
    const bytes = pending ? pending.source : listed.has(table) ? inventory.files.get(table)?.toString('utf8') : null;
    if (bytes == null || !moved.size) continue;
    const result = repointTable(bytes, moved);
    if (!result.count) continue;
    if (pending) { pending.source = result.source; pending.changes.push(`${result.count} test path table rows`); }
    else writes.push({ file: home, source: result.source, changes: [`${result.count} test path table rows`] });
  }
  return { cell: cell.name, moves: [...moved], writes, already };
}

/** Apply a planned move: git mv each file to its home, then write and stage the repointed import specifiers. */
export function applyTestMove(root, planned, git) {
  for (const [from, to] of planned.moves) {
    mkdirSync(join(root, posix.dirname(to)), { recursive: true });
    git(['mv', '--', from, to]);
  }
  for (const write of planned.writes) writeFileSync(join(root, write.file), write.source);
  if (planned.writes.length) git(['add', '--', ...planned.writes.map(write => write.file)]);
  return testMoveReport(planned);
}

/** Render what a move did: each move, each repointed specifier, each path already home, or that nothing moved. */
export function testMoveReport(planned) {
  const lines = [...planned.moves.map(([from, to]) => `moved ${from} -> ${to}`),
    ...planned.writes.flatMap(write => write.changes.map(change => `repointed ${write.file}: ${change}`)),
    ...planned.already.map(file => `already home: ${file}`)];
  if (!planned.moves.length) lines.push(`nothing to move for ${planned.cell}`);
  return lines;
}
