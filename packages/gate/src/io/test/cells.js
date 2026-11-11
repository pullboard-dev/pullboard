#!/usr/bin/env node
/**
 * Classify every test file as a cell test or a listed journey, report each other test as a finding naming the rule it breaks,
 * ratchet the findings and the root test/ file count, and report per cell whether it is sealed [C7].
 */
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  posix,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { blobOid } from '../static/cache.js';
import {
  cellOf,
  importSpecifiers,
} from '../edges.js';
import {
  TEST_FILE,
  report,
  walk,
} from '../scan.js';

const LISTING = 'packages/gate/data/tests/test-cells.json';
const TEST_DIRECTORY = /^(?:test|packages\/[^/]+\/tests|apps\/[^/]+\/tests)\//u;
const TEST = { test: file => TEST_DIRECTORY.test(file) && TEST_FILE.test(file) };
const SOURCE = /^(?:src|packages|apps|bin)\/.*\.[cm]?js$/u;
// A call that starts a child process; a launch is one whose arguments name the CLI entry, directly or through a path variable.
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|fork|exec|execSync|runFixtureChild|runFixtureChildAsync|startFixtureChild)\s*\(([^;]*)/gu;
// The CLI entries and the test helpers that launch it; reaching one through imports is a launch.
const CLI_ENTRIES = new Set(['apps/cli/index.js', 'apps/cli/pullboard.js', 'apps/cli/tests/fixtures/e2e.js', 'apps/cli/tests/fixtures/native.js', 'apps/cli/tests/fixtures/process.js']);

/**
 * Whether a source installs git hooks: an installHooks call, or a child-process call that runs a hooks install or sets
 * core.hooksPath to a folder. Pointing core.hooksPath at /dev/null disables hooks, and a string naming the setting in
 * expected output installs nothing [C7].
 */
export function installsHooks(source) {
  if (/\binstallHooks\s*\(/u.test(source)) return true;
  for (const call of source.matchAll(SPAWN)) {
    const args = call[1];
    if (/['"`]hooks['"`]\s*,\s*['"`]install['"`]|\bhooks\s+install\b|install-hooks/u.test(args)) return true;
    const path = /core\.hooksPath(?:=|['"`]\s*,\s*['"`])([^'"`\s,)]*)/u.exec(args);
    if (path && path[1] && path[1] !== '/dev/null') return true;
  }
  return false;
}

/**
 * Whether a source spawns the CLI: a child-process call whose arguments name apps/cli/pullboard.js, or name a variable that a
 * path expression (join, resolve or new URL) points at apps/cli/pullboard.js. A plain data string that only mentions the path
 * launches nothing [C7].
 */
export function spawnsCli(source) {
  const paths = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*(?:join|resolve|new\s+URL|fileURLToPath)\s*\([^;\n]*(?:bin|apps\/cli)\/pullboard\.js/gu)].map(m => m[1]);
  for (const call of source.matchAll(SPAWN)) {
    if (/(?:bin|apps\/cli)\/pullboard\.js/u.test(call[1])) return true;
    if (paths.some(name => new RegExp(`(?<![\\w$])${name.replace(/\$/gu, '\\$')}(?![\\w$])`, 'u').test(call[1]))) return true;
  }
  return false;
}

/**
 * The CLI entry a test file reaches through its test-side imports, or null: a test or test helper importing
 * apps/cli/index.js or apps/cli/pullboard.js runs the CLI in process, and one importing a CLI-launching helper launches it.
 * Product modules are not followed: what a cell itself imports is judged by the front-door rules, not as a launch. A test
 * inside apps/cli importing its own front door is that cell's unit test.
 */
export function reachedCliEntry(root, file) {
  const own = testCellOf(file);
  const seen = new Set([file]), queue = [file];
  for (let at = 0; at < queue.length; at++) {
    const current = queue[at];
    if (!existsSync(resolve(root, current))) continue;
    for (const { specifier } of importSpecifiers(readFileSync(resolve(root, current), 'utf8'))) {
      const target = posix.normalize(posix.join(posix.dirname(current), specifier));
      if (CLI_ENTRIES.has(target) && !(own === 'apps/cli' && target.startsWith('apps/cli/'))) return target;
      const testSide = target.startsWith('test/') || /^(?:packages|apps)\/[^/]+\/tests\//u.test(target);
      if (testSide && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return null;
}

/**
 * The cell a test file sits in, named as cellOf names it: `<cell>` for `packages/<cell>/tests/...` and `apps/<name>` for
 * `apps/<name>/tests/...`, so an app test importing its own app is never read as leaving its cell; root test/ has none.
 *
 * @param {string} file - Repo-relative path.
 * @returns {string | null}
 */
export function testCellOf(file) {
  const match = /^(packages|apps)\/([^/]+)\/tests\//u.exec(file);
  if (!match) return null;
  return match[1] === 'apps' ? `apps/${match[2]}` : match[2];
}

/**
 * Each planned cell's order from the packages/codemap/data/plan/cells.json index, keyed as cellOf names cells (an `app:<name>` cell is
 * `apps/<name>`). A component test may import only cells below its own, so the order decides which front doors it may use.
 *
 * @param {string} root
 * @returns {Map<string, number>}
 */
export function planOrder(root) {
  const path = resolve(root, 'packages/codemap/data/plan/cells.json');
  if (!existsSync(path)) return new Map();
  const cells = JSON.parse(readFileSync(path, 'utf8')).cells ?? [];
  return new Map(cells.map(cell => [cell.name.startsWith('app:') ? `apps/${cell.name.slice(4)}` : cell.name, cell.order]));
}

/** The listing's pure helpers as path to reason; an older array listing carries no reasons. */
function pureHelperMap(pureHelpers) {
  return Array.isArray(pureHelpers) ? Object.fromEntries(pureHelpers.map(path => [path, ''])) : { ...pureHelpers };
}

/** Whether a target is a cell's front door: its index.js, or its core.js door (an app's core.js is a light door); a package may add pure.js. */
function frontDoor(target, cell) {
  const base = cell.startsWith('apps/') ? cell : `packages/${cell}`;
  return target === `${base}/index.js` || target === `${base}/light.js` || (!cell.startsWith('apps/') && target === `${base}/browser.js`);
}

/** The committed listing: journeys with their reasons, the pure helpers and leaf cells a cell test may import, the ratchet, the sealed cells. */
export function readListing(root) {
  const path = resolve(root, LISTING);
  const empty = { journeys: {}, pureHelpers: [], leaves: [], findings: {}, rootTests: 0, sealed: [], splits: {} };
  return existsSync(path) ? { ...empty, ...JSON.parse(readFileSync(path, 'utf8')) } : empty;
}

/**
 * Every rule one cell test breaks, by what its source imports and launches; an empty list means it conforms.
 *
 * @param {string} file - Repo-relative path under `<cell>/tests/`.
 * @param {string} source
 * @param {{ pureHelpers?: string[] | Record<string, string>, leaves?: string[], order?: Map<string, number> }} [listing]
 * @returns {{ line: number, text: string }[]}
 */
export function cellTestProblems(file, source, { pureHelpers = [], leaves = [], order = new Map(), root = null } = {}) {
  return cellTestReading(file, source, { pureHelpers, leaves, order, root }).problems;
}

/**
 * A cell test's problems and its tier. A unit test imports only its own cell, leaf front doors and pure helpers; a
 * component test also imports front doors of cells below its own in plan order (V23: it lives in the last cell it spans).
 *
 * @returns {{ problems: { line: number, text: string }[], tier: 'unit' | 'component' }}
 */
export function cellTestReading(file, source, { pureHelpers = [], leaves = [], order = new Map(), root = null } = {}) {
  const own = testCellOf(file);
  const helpers = pureHelperMap(pureHelpers);
  const problems = [];
  let tier = 'unit';
  for (const { specifier, line } of importSpecifiers(source)) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    const where = cellOf(target).cell;
    if (where === own || Object.hasOwn(helpers, target)) continue;
    if (leaves.includes(where) && frontDoor(target, where)) continue;
    if (frontDoor(target, where) && order.has(where) && order.has(own) && order.get(where) < order.get(own)) { tier = 'component'; continue; }
    problems.push({ line, text: `imports ${target}, outside its own cell ${own}; a cell test imports its own cell, the front door of a cell below it, a leaf cell's front door or a pure testkit helper` });
  }
  if (spawnsCli(source) || (root && reachedCliEntry(root, file))) problems.push({ line: 1, text: 'spawns or reaches the CLI; a cell test spawns no CLI, so move it to the journeys or cut the CLI out of it' });
  if (installsHooks(source)) problems.push({ line: 1, text: 'installs hooks; a cell test installs none, so move it to the journeys or cut the hooks out of it' });
  return { problems, tier };
}


/**
 * Each listed pure helper that is not pure, checked on every run so the list cannot rot (sealing rules 1 and 7): missing,
 * its whole import closure reaching a CLI entry, or a test-side file in that closure that installs hooks or spawns the CLI.
 * Running git or plain node child processes and importing product front doors that stay clear of the CLI are allowed.
 *
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function impurePureHelpers(root, listing, { cache = null } = {}) {
  const problems = [];
  const facts = importFacts(root, cache);
  for (const path of Object.keys(pureHelperMap(listing.pureHelpers)).sort()) {
    if (!existsSync(resolve(root, path))) { problems.push({ path: LISTING, line: 1, text: `listed pure helper ${path} does not exist` }); continue; }
    const reason = impurity(root, path, facts);
    if (reason) problems.push({ path, line: 1, text: `listed as a pure helper but ${reason}` });
  }
  return problems;
}

/**
 * What the helper walk needs of one file: its relative import specifiers and whether it launches the CLI or installs hooks.
 * Read once per run, and kept by blob oid in `cache` when one is given, so the closure walk lexes only changed files [5564].
 *
 * @returns {(file: string) => { specifiers: string[], launches: boolean }}
 */
function importFacts(root, cache) {
  const memo = new Map();
  return file => {
    if (!memo.has(file)) {
      const source = readFileSync(resolve(root, file), 'utf8');
      const read = () => ({ specifiers: importSpecifiers(source).map(row => row.specifier), launches: spawnsCli(source) || installsHooks(source) });
      memo.set(file, cache ? cache.get(file, blobOid(source), read) : read());
    }
    return memo.get(file);
  };
}

/** Why one helper is not pure, walking its full relative import closure, or null when it is. */
function impurity(root, path, facts) {
  const seen = new Set([path]), queue = [path];
  for (let at = 0; at < queue.length; at++) {
    const file = queue[at];
    if (file !== path && CLI_ENTRIES.has(file)) return `its import closure reaches the CLI entry ${file}`;
    const { specifiers, launches } = facts(file);
    if (file.startsWith('test/') && launches) return `${file === path ? 'it' : file} launches the CLI or installs hooks`;
    for (const specifier of specifiers) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!seen.has(target) && existsSync(resolve(root, target))) { seen.add(target); queue.push(target); }
    }
  }
  return null;
}

/**
 * Classify every test file under the tree: `cell` (conforming), `journey` (a root test listed with a reason) or `finding`.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (file: string) => string, listing?: ReturnType<typeof readListing> }} [options]
 * @returns {{ file: string, kind: 'cell' | 'journey' | 'finding', tier?: 'unit' | 'component' | null, cell: string | null, root: boolean, problems: { line: number, text: string }[] }[]}
 */
export function classifyTests(root, { files, read = file => readFileSync(resolve(root, file), 'utf8'), listing = readListing(root), order = planOrder(root) } = {}) {
  return (files ?? walk(root, TEST_FILE)).filter(file => TEST.test(file)).map(file => {
    const cell = testCellOf(file);
    if (!cell) {
      const reason = listing.journeys[file];
      if (typeof reason === 'string' && reason.trim()) return { file, kind: 'journey', cell: null, root: true, problems: [] };
      return { file, kind: 'finding', cell: null, root: true, problems: [{ line: 1, text: `unlisted root test; a test under test/ is a journey that names its reason in ${LISTING}, or it moves to its cell's tests/ folder` }] };
    }
    const { problems, tier } = cellTestReading(file, read(file), { ...listing, order, root });
    return { file, kind: problems.length ? 'finding' : 'cell', tier: problems.length ? null : tier, cell, root: false, problems };
  });
}

/**
 * Per cell: whether it is sealed. A cell is sealed when it has tests, every one conforms, and no file outside it imports past its front door.
 *
 * @param {ReturnType<typeof classifyTests>} rows
 * @param {{ cells: string[], deepImporters?: Record<string, number> }} facts
 * @returns {{ cell: string, sealed: boolean, tests: number, findings: number, deepImporters: number }[]}
 */
export function sealedReport(rows, { cells, deepImporters = {} }) {
  return [...new Set(cells)].sort().map(cell => {
    const own = rows.filter(row => row.cell === cell);
    const findings = own.filter(row => row.kind === 'finding').length;
    const deep = deepImporters[cell] ?? 0;
    return { cell, sealed: own.length > 0 && findings === 0 && deep === 0, tests: own.length, findings, deepImporters: deep };
  });
}

/** Names of every cell directory under packages/ and apps/, and each cell's count of outside files importing past its front door. */
function cellFacts(root) {
  const files = walk(root, /^(?:packages|apps)\/.*\.[cm]?js$|^(?:src|bin)\/.*\.[cm]?js$/u);
  const cells = new Set(), deepImporters = {};
  for (const file of files) if (/^(?:packages|apps)\/[^/]+\//u.test(file)) cells.add(cellOf(file).cell);
  // Journeys are tests too: the old root test/ folder moved under apps/<app>/journeys/ [V32].
  for (const file of files.filter(name => SOURCE.test(name) && (/\/src\//u.test(name) || !/(?:^|\/)(?:tests?|journeys)\//u.test(name)))) {
    const own = cellOf(file).cell;
    for (const { specifier } of importSpecifiers(readFileSync(resolve(root, file), 'utf8'))) {
      const target = cellOf(posix.normalize(posix.join(posix.dirname(file), specifier)));
      if (target.deep && target.cell !== own) deepImporters[target.cell] = (deepImporters[target.cell] ?? 0) + 1;
    }
  }
  return { cells: [...cells], deepImporters };
}

/**
 * Today's report: every row, the findings keyed by path, the root test count and the per-cell seal rows.
 *
 * @param {string} root
 * @param {object} [options] - As classifyTests, plus `facts` ({ cells, deepImporters }) to skip reading the source tree.
 */
export function testCellsReport(root, { facts, ...options } = {}) {
  const rows = classifyTests(root, options);
  const findings = {};
  for (const row of rows.filter(entry => entry.kind === 'finding')) findings[row.file] = row.problems.map(problem => problem.text);
  return { rows, findings, rootTests: rootTestCount(rows, (options.listing ?? readListing(root)).splits), cells: sealedReport(rows, facts ?? cellFacts(root)) };
}

/**
 * The root test count, where the present targets of each declared split count as their one source: splitting a slow root
 * journey into files adds no test, so it never raises the ratchet. The split's own case-coverage test proves every case
 * lands in exactly one target.
 */
export function rootTestCount(rows, splits = {}) {
  const root = new Set(rows.filter(row => row.root).map(row => row.file));
  let count = root.size;
  for (const [source, targets] of Object.entries(splits ?? {})) {
    const present = (Array.isArray(targets) ? targets : []).filter(target => root.has(target)).length;
    if (present && !root.has(source)) count -= present - 1;
  }
  return count;
}

/** Each malformed declared split: a target that is missing or not a root test, or a target in two splits. */
function splitProblems(root, splits = {}) {
  const problems = [], seen = new Map();
  for (const [source, targets] of Object.entries(splits ?? {})) {
    if (!Array.isArray(targets) || !targets.length) { problems.push({ path: LISTING, line: 1, text: `split ${source} names no target files` }); continue; }
    for (const target of targets) {
      if (!target.startsWith('test/') || !TEST.test(target)) problems.push({ path: LISTING, line: 1, text: `split ${source} target ${target} is not a root test file` });
      else if (!existsSync(resolve(root, target))) problems.push({ path: LISTING, line: 1, text: `split ${source} target ${target} does not exist` });
      if (seen.has(target)) problems.push({ path: LISTING, line: 1, text: `split target ${target} sits in two splits, ${seen.get(target)} and ${source}` });
      seen.set(target, source);
    }
  }
  return problems;
}

/**
 * Whether the listing already carries a file's finding: under its own path, or, for a test in a cell's tests/ folder, under
 * the root test/ path the test mover moved it from (`<cell>/tests/<path>` comes from `test/<path>`), so a pure move keeps
 * its finding's identity and the ratchet never reads it as new.
 */
function listedFinding(listing, file) {
  if (Object.hasOwn(listing.findings, file)) return true;
  // A target of a declared split carries the finding its source had.
  for (const [source, targets] of Object.entries(listing.splits ?? {})) {
    if (Array.isArray(targets) && targets.includes(file) && Object.hasOwn(listing.findings, source)) return true;
  }
  const moved = /^(?:packages|apps)\/[^/]+\/tests\/(.+)$/u.exec(file);
  return Boolean(moved) && Object.hasOwn(listing.findings, `test/${moved[1]}`);
}

/**
 * Refuse a finding the committed listing does not already carry (naming its rule), more root test files than it counts,
 * and a cell it lists as sealed that no longer is.
 *
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function testCellsProblems(root, options = {}) {
  const listing = options.listing ?? readListing(root);
  const current = testCellsReport(root, { ...options, listing });
  const problems = [];
  const add = (path, line, text) => problems.push({ path, line, text });
  problems.push(...impurePureHelpers(root, listing, { cache: options.cache }));
  problems.push(...splitProblems(root, listing.splits));
  for (const row of current.rows.filter(entry => entry.kind === 'finding' && !listedFinding(listing, entry.file))) {
    for (const problem of row.problems) add(row.file, problem.line, `new test finding exceeds the ratchet: ${problem.text}`);
  }
  if (current.rootTests > listing.rootTests) add('test', 1, `${current.rootTests} root test files exceed the ratchet of ${listing.rootTests}; put new tests in their cell's tests/ folder`);
  const sealedNow = new Set(current.cells.filter(row => row.sealed).map(row => row.cell));
  for (const cell of listing.sealed.filter(name => !sealedNow.has(name))) add(cell.startsWith('apps/') ? cell : `packages/${cell}`, 1, `cell ${cell} is no longer sealed: a test breaks a cell-test rule or a file imports past its front door`);
  return problems;
}

/**
 * Record the ratchet for today's tree. It only lowers: it refuses to record a finding the committed listing lacks or a higher
 * root test count, unless `initialize` is set for the first write.
 */
export function writeTestCells(root, { initialize = false } = {}) {
  const listing = readListing(root);
  const current = testCellsReport(root, { listing });
  const raised = Object.keys(current.findings).filter(file => !listedFinding(listing, file));
  if (!initialize && (raised.length || current.rootTests > listing.rootTests)) {
    return [{ path: LISTING, line: 1, text: `the ratchet only lowers; fix ${raised.length ? raised.join(', ') : 'the extra root tests'} instead of recording them` }];
  }
  const findings = {};
  for (const file of Object.keys(current.findings).sort()) findings[file] = current.findings[file][0];
  const next = { ...listing, findings, rootTests: current.rootTests, sealed: current.cells.filter(row => row.sealed).map(row => row.cell) };
  writeFileSync(resolve(root, LISTING), `${JSON.stringify(next, null, 2)}\n`);
  return [];
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const flags = ['--report', '--sealed', '--write', '--init'];
  const root = resolve(process.argv.slice(2).find(argument => !flags.includes(argument)) ?? '.');
  if (process.argv.includes('--sealed')) console.log(testCellsReport(root).cells.map(row => `${row.cell}\t${row.sealed ? 'sealed' : 'open'}\t${row.tests} tests\t${row.findings} findings\t${row.deepImporters} deep importers`).join('\n'));
  else if (process.argv.includes('--report')) { const current = testCellsReport(root); console.log(JSON.stringify({ findings: current.findings, rootTests: current.rootTests, cells: current.cells }, null, 2)); }
  else if (process.argv.includes('--write') || process.argv.includes('--init')) report(writeTestCells(root, { initialize: process.argv.includes('--init') }));
  else report(testCellsProblems(root));
}
