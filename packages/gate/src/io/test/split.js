/**
 * Move every per-file registry row from a split test file to its new siblings in one step [C7].
 *
 * Why: a split met about eight path-keyed registries owned by different lanes, and each cost an item (#5769).
 * Counted ceilings are measured again per file and may only fall over the family; listings copy the original's row.
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliLaunchReport } from './launches.js';
import { testWaitReport } from './waits.js';
import { fixtureReport } from './fixtures.js';
import { boardFileReport } from '../board/files.js';
import { generateTestTiers } from './tiers.js';
import { TEST_TIERS_FILE } from './tiers.js';
import { formatTestTiers } from './tiers.js';
import { planLintSplit } from './split/lints.js';
import { withCellLintParser } from '../../../../codemap/index.js';
import { cellLintReport } from '../../../../codemap/index.js';
import { cellLintParsers } from '../../../../codemap/index.js';
import { readCellLintBaseline } from '../../../../codemap/index.js';
import { mainCellLintReport } from '../../../../codemap/index.js';
import { TEST_JOURNEYS_FILE } from './derived.js';
import { CLI_LAUNCHES_FILE } from '../static/registry.js';
import { BASELINE_TABLES } from '../../../../commits/light.js';
import { CONFIG_FILE } from '../../../../config/index.js';
import { Refused } from '../../../../kernel/index.js';

/** The fixture and wait ceilings, named once by their owner as [fixtures, waits]. */
const [FIXTURES_FILE, WAITS_FILE] = BASELINE_TABLES;
export const SPLIT_REGISTRIES = Object.freeze({
  launches: CLI_LAUNCHES_FILE,
  waits: WAITS_FILE,
  fixtures: FIXTURES_FILE,
  boardFiles: 'packages/gate/src/io/board/baseline.js',
  journeys: TEST_JOURNEYS_FILE,
  tiers: TEST_TIERS_FILE,
  roles: 'apps/view/src/logic/roles.js',
  lanes: CONFIG_FILE,
  pathMap: 'packages/codemap/data/plan/path-map',
});
const TEST = /\.test\.[cm]?js$/u;
const pretty = value => JSON.stringify(value, null, 2) + '\n';

/** Per-file, per-kind counts of measured sites for the family's files only. */
function familyCounts(sites, family) {
  const counts = new Map();
  for (const { path, kind } of sites) {
    if (!family.has(path)) continue;
    const row = counts.get(path) ?? {};
    row[kind] = (row[kind] ?? 0) + 1;
    counts.set(path, row);
  }
  return counts;
}

/** Sum a family's counts per kind. */
function totals(rows) {
  const sum = {};
  for (const row of rows) for (const [kind, count] of Object.entries(row ?? {})) sum[kind] = (sum[kind] ?? 0) + count;
  return sum;
}

/**
 * Replace the family's rows of a path-keyed map, keeping every other key in place; the new rows sit where the first
 * family row was, else at the end.
 */
function replaceRows(map, files, rows) {
  const out = {};
  let placed = false;
  const place = () => { if (!placed) for (const file of files) if (rows.has(file)) out[file] = rows.get(file); placed = true; };
  for (const [key, value] of Object.entries(map)) {
    if (files.includes(key)) place();
    else out[key] = value;
  }
  place();
  return out;
}

/** Plan a counted ceiling: measured rows per file, refused when any kind rises over the family. */
function countedPlan(registry, map, files, counts) {
  const before = totals(files.map(file => map[file])), after = totals([...counts.values()]);
  const rose = Object.keys(after).filter(kind => after[kind] > (before[kind] ?? 0));
  const row = { registry, before: Object.values(before).reduce((a, b) => a + b, 0), after: Object.values(after).reduce((a, b) => a + b, 0), rose: rose.length > 0, kinds: rose };
  return { row, next: replaceRows(map, files, counts) };
}

/** Read the board-file ceiling's literal object rows, in order. */
function boardRows(text) {
  return Object.fromEntries([...text.matchAll(/^ {2}"([^"]+)": (\d+),$/gmu)].map(match => [match[1], Number(match[2])]));
}

/** Rewrite the board-file ceiling's rows without touching its comment or export line. */
function boardText(text, rows) {
  const start = text.indexOf('{\n') + 2, end = text.lastIndexOf('};');
  return text.slice(0, start) + Object.entries(rows).map(([path, count]) => `  ${JSON.stringify(path)}: ${count},\n`).join('') + text.slice(end);
}

/** Find a role entry's key and balanced object text in roles.js, quoting either way. */
function roleEntry(text, file) {
  for (const quote of ["'", '"']) {
    const head = `${quote}${file}${quote}: {`, at = text.indexOf(head);
    if (at < 0) continue;
    let depth = 0, index = at + head.length - 1, inside = null;
    for (; index < text.length; index++) {
      const char = text[index];
      if (inside) { if (char === '\\') index++; else if (char === inside) inside = null; continue; }
      if (char === '"' || char === "'" || char === '`') inside = char;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) break;
    }
    return { start: at, end: index + 1, body: text.slice(at + head.length - 1, index + 1) };
  }
  return null;
}

/** Copy the original's view role to new test siblings; a removed original hands its entry over. */
function rolesText(text, original, siblings, kept) {
  const entry = roleEntry(text, original);
  if (!entry) return text;
  const added = siblings.filter(file => TEST.test(file) && !roleEntry(text, file)).map(file => `${JSON.stringify(file)}: ${entry.body}`);
  if (!added.length && kept) return text;
  if (!kept) return text.slice(0, entry.start) + added.join(',\n  ') + text.slice(entry.end);
  return text.slice(0, entry.end) + added.map(row => `,\n  ${row}`).join('') + text.slice(entry.end);
}

/** Read a JSON registry, or null when this tree has none. */
function readJson(root, file) {
  return existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), 'utf8')) : null;
}

/**
 * The tree's measured lint report, main's measured report and the committed baseline, through the codemap parser.
 * Why main: the cells check judges growth against main's measured debt, and the committed rows can be stale either way.
 * `base` names the commit the split started from when main has moved past it.
 */
async function measuredLints(root, base) {
  return withCellLintParser(compile => {
    const parsers = cellLintParsers(compile);
    return { report: cellLintReport(root, parsers), base: (base ? mainCellLintReport(root, parsers, base) : mainCellLintReport(root, parsers))?.report ?? null, effective: readCellLintBaseline(root) };
  });
}

/**
 * Plan and write every registry for one split. Nothing is written when any counted budget would rise.
 *
 * @param {string} root - Repository root holding the already split files.
 * @param {string} original - The test path before the split; it may remain as one sibling or be gone.
 * @param {string[]} siblings - The new files that took its contents.
 * @param {{ lints?: (root: string, base: string | null) => Promise<{ report: object, base: object | null, effective: object }>, tiers?: (root: string) => { files: object[] }, write?: boolean, base?: string | null }} [options]
 *   `lints` and `tiers` measure the tree; tests pass small stand-ins, the command the real scanners.
 * @returns {Promise<{ rows: object[], written: string[] }>}
 */
export async function splitRegistries(root, original, siblings, { lints = measuredLints, tiers = generateTestTiers, write = true, base = null } = {}) {
  if (!original || !siblings.length) throw new Refused('SPLIT_USAGE', 'name the original test path and at least one new file', 'node packages/gate/src/io/test/scripts/split.js <original> <new>...');
  const missing = siblings.filter(file => !existsSync(join(root, file)));
  if (missing.length) throw new Refused('SPLIT_USAGE', `new files are missing: ${missing.join(', ')}`, 'write the split first, then run the command');
  const kept = existsSync(join(root, original));
  const files = [original, ...siblings.filter(file => file !== original)];
  const family = new Set(files), rows = [], writes = new Map();
  for (const [name, scan] of [['launches', cliLaunchReport], ['waits', testWaitReport], ['fixtures', fixtureReport]]) {
    const map = readJson(root, SPLIT_REGISTRIES[name]);
    if (!map) { rows.push({ registry: name, skipped: 'absent' }); continue; }
    const plan = countedPlan(name, map, files, familyCounts(scan(root), family));
    rows.push(plan.row);
    writes.set(SPLIT_REGISTRIES[name], pretty(plan.next));
  }
  const boardPath = join(root, SPLIT_REGISTRIES.boardFiles);
  if (existsSync(boardPath)) {
    const text = readFileSync(boardPath, 'utf8'), map = boardRows(text);
    const counts = new Map([...familyCounts(boardFileReport(root).map(row => ({ ...row, kind: 'open' })), family)].map(([path, row]) => [path, row.open]));
    const before = files.reduce((sum, file) => sum + (map[file] ?? 0), 0), after = [...counts.values()].reduce((a, b) => a + b, 0);
    rows.push({ registry: 'boardFiles', before, after, rose: after > before });
    writes.set(SPLIT_REGISTRIES.boardFiles, boardText(text, replaceRows(map, files, counts)));
  }
  const journeys = readJson(root, SPLIT_REGISTRIES.journeys);
  if (journeys?.files?.[original]) {
    const copies = new Map(files.filter(file => file === original ? kept : TEST.test(file) && !journeys.files[file]).map(file => [file, journeys.files[original]]));
    for (const file of files) if (file !== original && journeys.files[file]) copies.set(file, journeys.files[file]);
    journeys.files = replaceRows(journeys.files, files, copies);
    rows.push({ registry: 'journeys', copied: [...copies.keys()].filter(file => file !== original).length });
    writes.set(SPLIT_REGISTRIES.journeys, pretty(journeys));
  }
  const manifest = readJson(root, SPLIT_REGISTRIES.tiers);
  if (manifest) {
    const fresh = new Map(tiers(root).files.filter(row => family.has(row.file)).map(row => [row.file, row]));
    const at = manifest.files.findIndex(row => family.has(row.file));
    const others = manifest.files.filter(row => !family.has(row.file));
    const index = at < 0 ? others.length : manifest.files.slice(0, at).filter(row => !family.has(row.file)).length;
    manifest.files = [...others.slice(0, index), ...files.filter(file => fresh.has(file)).map(file => fresh.get(file)), ...others.slice(index)];
    rows.push({ registry: 'tiers', classified: fresh.size });
    writes.set(SPLIT_REGISTRIES.tiers, formatTestTiers(manifest));
  }
  const rolesPath = join(root, SPLIT_REGISTRIES.roles);
  if (existsSync(rolesPath)) {
    const before = readFileSync(rolesPath, 'utf8'), after = rolesText(before, original, files.slice(1), kept);
    rows.push({ registry: 'roles', changed: before !== after });
    if (before !== after) writes.set(SPLIT_REGISTRIES.roles, after);
  }
  const config = readJson(root, SPLIT_REGISTRIES.lanes);
  if (config?.lanes) {
    const lanes = [];
    for (const [name, lane] of Object.entries(config.lanes)) {
      const owns = lane.owns ?? [];
      if (!owns.includes(original)) continue;
      const covered = file => owns.some(path => path === file || path.endsWith('/') && file.startsWith(path));
      const added = files.slice(1).filter(file => !covered(file));
      const at = owns.indexOf(original);
      lane.owns = [...owns.slice(0, kept ? at + 1 : at), ...added, ...owns.slice(at + 1)];
      lanes.push(name);
    }
    rows.push({ registry: 'lanes', lanes });
    if (lanes.length) writes.set(SPLIT_REGISTRIES.lanes, pretty(config));
  }
  const mapDirectory = join(root, SPLIT_REGISTRIES.pathMap);
  const mapped = existsSync(mapDirectory) ? readdirSync(mapDirectory).filter(name => name.endsWith('.json'))
    .flatMap(name => Object.entries(JSON.parse(readFileSync(join(mapDirectory, name), 'utf8'))).filter(([, to]) => to === original).map(([from]) => `${name}:${from}`)) : [];
  if (mapped.length && !kept) throw new Refused('SPLIT_PATH_MAP', `the path map still moves ${mapped.join(', ')} to ${original}`, `keep ${original} as one sibling of the split; a path-map move needs its own declared plan row`);
  rows.push({ registry: 'pathMap', kept: mapped.length });
  if (lints) {
    const measured = await lints(root, base);
    const plan = planLintSplit(root, files, measured);
    rows.push(...plan.rows);
    for (const [file, bytes] of plan.writes) writes.set(file, bytes);
  }
  const risen = rows.filter(row => row.rose);
  if (risen.length) {
    throw new Refused('SPLIT_RATCHET', `the split raises ${risen.map(row => `${row.registry} ${row.before} -> ${row.after}${row.kinds?.length ? ` (${row.kinds.join(', ')})` : ''}`).join('; ')}`, 'remove the new debt from the split files, or move it to a shared fixture that already carries it, then run the command again');
  }
  const written = [];
  for (const [file, bytes] of writes) {
    const path = join(root, file);
    if (existsSync(path) && readFileSync(path, 'utf8') === bytes) continue;
    if (write) writeFileSync(path, bytes);
    written.push(file);
  }
  return { rows, written };
}
