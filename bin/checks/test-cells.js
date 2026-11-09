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
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellOf, importSpecifiers } from './cells-edges.js';
import { TEST_FILE, report, walk } from './scan.js';

const LISTING = 'bin/checks/test-cells.json';
const TEST_DIRECTORY = /^(?:test|packages\/[^/]+\/tests|apps\/[^/]+\/tests)\//u;
const TEST = { test: file => TEST_DIRECTORY.test(file) && TEST_FILE.test(file) };
const SOURCE = /^(?:src|packages|apps|bin)\/.*\.[cm]?js$/u;
const CLI_LAUNCH = /bin\/pullboard(?:\.js)?\b|\bapps\/cli\b|\be2e-helpers\b|\bnative-cli-fixture\b|\bcli-in-process-fixture\b/u;
const HOOKS = /\binstallHooks\b|\bhooks\s+install\b|\bcore\.hooksPath\b|\binstall-hooks\b/u;

/**
 * The cell a test file sits in: `packages/<cell>/tests/...` or `apps/<cell>/tests/...`; a file under root test/ has none.
 *
 * @param {string} file - Repo-relative path.
 * @returns {string | null}
 */
export function testCellOf(file) {
  const match = /^(?:packages|apps)\/([^/]+)\/tests\//u.exec(file);
  return match ? match[1] : null;
}

/** The committed listing: journeys with their reasons, the pure helpers and leaf cells a cell test may import, the ratchet, the sealed cells. */
export function readListing(root) {
  const path = resolve(root, LISTING);
  const empty = { journeys: {}, pureHelpers: [], leaves: [], findings: {}, rootTests: 0, sealed: [] };
  return existsSync(path) ? { ...empty, ...JSON.parse(readFileSync(path, 'utf8')) } : empty;
}

/**
 * Every rule one cell test breaks, by what its source imports and launches; an empty list means it conforms.
 *
 * @param {string} file - Repo-relative path under `<cell>/tests/`.
 * @param {string} source
 * @param {{ pureHelpers?: string[], leaves?: string[] }} [listing]
 * @returns {{ line: number, text: string }[]}
 */
export function cellTestProblems(file, source, { pureHelpers = [], leaves = [] } = {}) {
  const own = testCellOf(file);
  const problems = [];
  for (const { specifier, line } of importSpecifiers(source)) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    const where = cellOf(target).cell;
    if (where === own || pureHelpers.includes(target)) continue;
    if (leaves.includes(where) && target === `${/^apps\//u.test(target) ? 'apps' : 'packages'}/${where}/index.js`) continue;
    problems.push({ line, text: `imports ${target}, outside its own cell ${own}; a cell test imports only its own cell, a leaf cell's front door or a pure testkit helper` });
  }
  if (CLI_LAUNCH.test(source)) problems.push({ line: 1, text: 'spawns or reaches the CLI; a cell test spawns no CLI, so move it to the journeys or cut the CLI out of it' });
  if (HOOKS.test(source)) problems.push({ line: 1, text: 'installs hooks; a cell test installs none, so move it to the journeys or cut the hooks out of it' });
  return problems;
}

/**
 * Classify every test file under the tree: `cell` (conforming), `journey` (a root test listed with a reason) or `finding`.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (file: string) => string, listing?: ReturnType<typeof readListing> }} [options]
 * @returns {{ file: string, kind: 'cell' | 'journey' | 'finding', cell: string | null, root: boolean, problems: { line: number, text: string }[] }[]}
 */
export function classifyTests(root, { files, read = file => readFileSync(resolve(root, file), 'utf8'), listing = readListing(root) } = {}) {
  return (files ?? walk(root, TEST_FILE)).filter(file => TEST.test(file)).map(file => {
    const cell = testCellOf(file);
    if (!cell) {
      const reason = listing.journeys[file];
      if (typeof reason === 'string' && reason.trim()) return { file, kind: 'journey', cell: null, root: true, problems: [] };
      return { file, kind: 'finding', cell: null, root: true, problems: [{ line: 1, text: `unlisted root test; a test under test/ is a journey that names its reason in ${LISTING}, or it moves to its cell's tests/ folder` }] };
    }
    const problems = cellTestProblems(file, read(file), listing);
    return { file, kind: problems.length ? 'finding' : 'cell', cell, root: false, problems };
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
  for (const file of files) { const match = /^(?:packages|apps)\/([^/]+)\//u.exec(file); if (match) cells.add(match[1]); }
  for (const file of files.filter(name => SOURCE.test(name) && !/(?:^|\/)tests?\//u.test(name))) {
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
  return { rows, findings, rootTests: rows.filter(row => row.root).length, cells: sealedReport(rows, facts ?? cellFacts(root)) };
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
  for (const row of current.rows.filter(entry => entry.kind === 'finding' && !Object.hasOwn(listing.findings, entry.file))) {
    for (const problem of row.problems) add(row.file, problem.line, `new test finding exceeds the ratchet: ${problem.text}`);
  }
  if (current.rootTests > listing.rootTests) add('test', 1, `${current.rootTests} root test files exceed the ratchet of ${listing.rootTests}; put new tests in their cell's tests/ folder`);
  const sealedNow = new Set(current.cells.filter(row => row.sealed).map(row => row.cell));
  for (const cell of listing.sealed.filter(name => !sealedNow.has(name))) add(`packages/${cell}`, 1, `cell ${cell} is no longer sealed: a test breaks a cell-test rule or a file imports past its front door`);
  return problems;
}

/**
 * Record the ratchet for today's tree. It only lowers: it refuses to record a finding the committed listing lacks or a higher
 * root test count, unless `initialize` is set for the first write.
 */
export function writeTestCells(root, { initialize = false } = {}) {
  const listing = readListing(root);
  const current = testCellsReport(root, { listing });
  const raised = Object.keys(current.findings).filter(file => !Object.hasOwn(listing.findings, file));
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
