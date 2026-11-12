#!/usr/bin/env node
/** Report cell import edges with --report, lower the ceilings with --write, or refuse an undeclared new cross-cell import or deep import [C7]. */
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { gitSpawn } from '../../../git/index.js';
import {
  posix,
  resolve,
} from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import {
  lex,
  lineAt,
  report,
  walk,
} from './scan.js';

const CEILINGS = new URL('../../data/ceilings/cells-edges.json', import.meta.url);
const SOURCE = /^(?:src|packages|apps|bin)\/.*\.[cm]?js$/u;
const TESTISH = /(?:^|\/)test\/|\.(?:test|spec)\.[cm]?js$/u;
const ROOT_OWNER = '(root)';

/**
 * The six durable cells, top to bottom, and the only edges allowed between them (durable gate design, section 4):
 * land and drive sit on top, receipt and transport read pin, and jobs and pin import none of the six. No cell imports
 * drive or land. Any other edge between two of the six is a backwards edge, refused even when the plan declares it [C7].
 */
export const DURABLE_CELLS = Object.freeze({
  jobs: Object.freeze([]),
  drive: Object.freeze(['jobs', 'transport', 'receipt', 'pin']),
  transport: Object.freeze(['pin']),
  receipt: Object.freeze(['pin']),
  pin: Object.freeze([]),
  land: Object.freeze(['receipt', 'jobs', 'pin']),
});

/**
 * The cell that owns a repo-relative path: `packages/<name>` or `apps/<name>`; anything else is the root.
 *
 * @param {string} path
 * @returns {{ cell: string, deep: boolean }} The owner, and whether the path is inside that cell's src folder.
 */
export function cellOf(path) {
  const match = /^((?:packages|apps)\/[^/]+)\/(.*)$/u.exec(path);
  if (!match) return { cell: ROOT_OWNER, deep: false };
  return { cell: match[1].replace(/^packages\//u, ''), deep: match[2].startsWith('src/') };
}

/** A light door (a cell's core.js that may re-export shell modules) must cold-load within this many milliseconds [C7]. */
export const LIGHT_DOOR_BUDGET_MS = 100;

/** Slack in ms for a candidate that is over the budget while main is under it, so a few ms of noise never refuses it [C7]. */
const LIGHT_DOOR_NOISE_MS = 10;

/** Slack in ms (or a quarter of main's own load, if more) before an over-budget candidate counts as slower than main [C7]. */
const LIGHT_DOOR_WIDE_MARGIN_MS = 25;

/**
 * Every cell's declared light front door, read from the plan index and its shards.
 *
 * @param {string} root
 * @returns {string[]} Repo-relative core.js paths, in plan order; a missing or unreadable plan declares none.
 */
export function lightDoorsOf(root) {
  const doors = [];
  try {
    const index = JSON.parse(readFileSync(resolve(root, 'packages/codemap/data/plan/cells.json'), 'utf8'));
    for (const row of index.cells ?? []) {
      const cell = JSON.parse(readFileSync(resolve(root, row.file), 'utf8'));
      if (typeof cell.lightFrontDoor === 'string') doors.push(cell.lightFrontDoor);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return doors;
}

/**
 * One cold load of a module in a fresh Node process, import only (no process start), in milliseconds.
 *
 * @param {string} root
 * @param {string} door - Repo-relative module path.
 * @returns {Promise<number>} Milliseconds, or Infinity when it never loads.
 */
function loadOnceMs(root, door) {
  const script = `const t = performance.now(); await import(${JSON.stringify(pathToFileURL(resolve(root, door)).href)}); process.stdout.write(String(performance.now() - t));`;
  return new Promise(done => {
    let out = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => done(Infinity));
    child.on('close', status => done(status === 0 ? Number(out) : Infinity));
  });
}

/** Round a best-of measure to whole milliseconds, at least 1; Infinity stays Infinity. */
const wholeMs = best => (Number.isFinite(best) ? Math.max(1, Math.round(best)) : Infinity);

/**
 * The cold load time of one module in a fresh Node process, import only (no process start), in whole milliseconds.
 * Why: a light door promises light-path code a cheap load; a loaded machine adds noise, so the best of up to five tries counts.
 *
 * @param {string} root
 * @param {string} door - Repo-relative module path.
 * @returns {Promise<number>} Milliseconds, or Infinity when it never loads.
 */
export async function coldLoadMs(root, door) {
  let best = Infinity;
  for (let attempt = 0; attempt < 5 && best > LIGHT_DOOR_BUDGET_MS; attempt += 1) best = Math.min(best, await loadOnceMs(root, door));
  return wholeMs(best);
}

/**
 * Judge one door's cold load against the budget and against main measured in the same run.
 * Why: a loaded machine pushes every load over the budget, main's included; only a candidate that is over the budget
 * and also slower than main by a margin is the candidate's doing [C7].
 *
 * @param {number} candidate - The candidate's cold load in ms.
 * @param {number | undefined} main - Main's cold load for the same door in the same run; undefined when main could not be measured.
 * @returns {boolean} True when the door should be refused.
 */
export function lightDoorRefused(candidate, main) {
  if (candidate <= LIGHT_DOOR_BUDGET_MS) return false;
  if (!Number.isFinite(main)) return true;
  const slower = candidate > main + Math.max(LIGHT_DOOR_WIDE_MARGIN_MS, main * 0.25);
  const overWhileMainUnder = main <= LIGHT_DOOR_BUDGET_MS && candidate > main + LIGHT_DOOR_NOISE_MS;
  return slower || overWhileMainUnder;
}

/**
 * Where main's tree lives for a candidate checkout: the main checkout that owns the shared git directory, or undefined.
 *
 * @param {string} root
 * @returns {Promise<string | undefined>}
 */
export async function mainRootOf(root) {
  const out = await new Promise(done => {
    let text = '';
    const child = gitSpawn(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', () => done(''));
    child.on('close', status => done(status === 0 ? text.trim() : ''));
  });
  if (!out) return undefined;
  const main = resolve(out, '..');
  return main === resolve(root) || !existsSync(main) ? undefined : main;
}

/**
 * Measure a candidate door and main's same door alternately, so both see the same machine load, and stop once the
 * verdict cannot change: the candidate is within budget, or the verdict holds on the best of up to five tries each.
 *
 * @param {string} root
 * @param {string} door
 * @param {string | undefined} mainRoot - Undefined, or a tree without the door, measures the candidate alone.
 * @returns {Promise<{ candidate: number, main: number | undefined }>}
 */
async function measureAgainstMain(root, door, mainRoot) {
  const hasMain = mainRoot !== undefined && existsSync(resolve(mainRoot, door));
  let candidate = Infinity, main = Infinity;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    candidate = Math.min(candidate, await loadOnceMs(root, door));
    if (candidate <= LIGHT_DOOR_BUDGET_MS) break;
    if (!hasMain) continue;
    main = Math.min(main, await loadOnceMs(mainRoot, door));
    if (!lightDoorRefused(wholeMs(candidate), wholeMs(main))) break;
  }
  return { candidate: wholeMs(candidate), main: hasMain && Number.isFinite(main) ? wholeMs(main) : undefined };
}

/**
 * The relative import specifiers of a source with their lines, read from the lexer so strings and comments never count.
 *
 * @param {string} source
 * @returns {{ specifier: string, line: number }[]}
 */
export function importSpecifiers(source) {
  const { code, strings } = lex(source);
  const found = [];
  for (const string of strings) {
    if (!/^\.\.?\//u.test(string.text)) continue;
    if (/(?:\bfrom|\bimport\s*\(?)\s*$/u.test(code.slice(Math.max(0, string.start - 24), string.start))) found.push({ specifier: string.text, line: lineAt(source, string.start) });
  }
  return found;
}

/**
 * Every other cell one file imports, each with whether the import reaches into that cell's src folder.
 *
 * @param {string} file - Repo-relative path.
 * @param {string} source
 * @returns {{ to: string, deep: boolean, line: number }[]}
 */
export function fileEdges(file, source) {
  const own = cellOf(file).cell;
  const edges = [];
  for (const { specifier, line } of importSpecifiers(source)) {
    const target = cellOf(posix.normalize(posix.join(posix.dirname(file), specifier)));
    if (target.cell !== own && target.cell !== ROOT_OWNER) edges.push({ to: target.cell, deep: target.deep, line });
  }
  return edges;
}

/**
 * The edges the plan declares: `from->to` allows a cross-cell import, `from->to/src` allows a deep one.
 *
 * @param {string} root
 * @returns {Set<string>}
 */
export function declaredEdges(root) {
  let plan = {};
  try { plan = JSON.parse(readFileSync(resolve(root, 'packages/codemap/data/plan/cells.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return new Set(plan.allowedEdges ?? []);
}

/**
 * Today's edges: per file the undeclared distinct cells and deep imports, and per cell the cells it imports and its deep importers.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (file: string) => string, edgesOf?: (file: string, source: string) => ReturnType<typeof fileEdges> }} [options] - `edgesOf` lets a caller answer a file's edges from a cache.
 * @returns {{ files: Record<string, { cells: number, deep: number, edges: { from: string, to: string, deep: boolean, line: number }[] }>, cells: Record<string, { imports: string[], deepImporters: number }> }}
 */
export function cellsEdgeReport(root, { files, read = file => readFileSync(resolve(root, file), 'utf8'), edgesOf = fileEdges } = {}) {
  const declared = declaredEdges(root);
  const names = (files ?? walk(root, SOURCE)).filter(file => SOURCE.test(file) && !TESTISH.test(file));
  const result = { files: {}, cells: {} };
  for (const file of names) {
    const from = cellOf(file).cell;
    const edges = edgesOf(file, read(file)).filter(edge => !declared.has(`${from}->${edge.to}${edge.deep ? '/src' : ''}`));
    if (!edges.length) continue;
    const cells = new Set(edges.map(edge => edge.to));
    const deep = edges.filter(edge => edge.deep);
    result.files[file] = { cells: cells.size, deep: deep.length, edges: edges.map(edge => ({ from, ...edge })) };
    const row = result.cells[from] ??= { imports: [], deepImporters: 0 };
    row.imports = [...new Set([...row.imports, ...cells])].sort();
    for (const target of new Set(deep.map(edge => edge.to))) (result.cells[`<-${target}`] ??= { imports: [], deepImporters: 0 }).deepImporters += 1;
  }
  return result;
}

/**
 * The ceilings to commit for today's report: file counts and cell rows only.
 *
 * @param {ReturnType<typeof cellsEdgeReport>} current
 * @returns {{ files: Record<string, { cells: number, deep: number }>, cells: Record<string, { imports: string[], deepImporters: number }> }}
 */
export function ceilingsOf(current) {
  const files = {}, cells = {};
  for (const [file, row] of Object.entries(current.files)) files[file] = { cells: row.cells, deep: row.deep };
  for (const [name, row] of Object.entries(current.cells)) cells[name] = row;
  return { files, cells };
}

/**
 * Refuse a file or cell whose undeclared edges grew past its ceiling, naming the plan declaration that would allow it.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (file: string) => string, edgesOf?: (file: string, source: string) => ReturnType<typeof fileEdges>, ceilings?: ReturnType<typeof ceilingsOf> }} [options] - `files` limits the check to those files (the pre-commit run).
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function cellsEdgeProblems(root, { files, read, edgesOf, ceilings = JSON.parse(readFileSync(CEILINGS, 'utf8')) } = {}) {
  const current = cellsEdgeReport(root, { files, ...(read ? { read } : {}), ...(edgesOf ? { edgesOf } : {}) });
  const problems = [];
  const add = (path, line, text) => problems.push({ path, line, text });
  for (const [file, row] of Object.entries(current.files)) {
    const allowed = ceilings.files[file] ?? { cells: 0, deep: 0 };
    const from = cellOf(file).cell;
    for (const edge of row.edges) {
      const fresh = edge.deep ? row.deep > allowed.deep : row.cells > allowed.cells;
      if (!fresh) continue;
      const declaration = `${from}->${edge.to}${edge.deep ? '/src' : ''}`;
      add(file, edge.line, edge.deep
        ? `deep import into ${edge.to}'s src exceeds the ratchet (${row.deep} > ${allowed.deep}); import ${edge.to}'s index, or add "${declaration}" to allowedEdges in packages/codemap/data/plan/cells.json`
        : `new cross-cell import of ${edge.to} exceeds the ratchet (${row.cells} cells > ${allowed.cells}); cut it, or add "${declaration}" to allowedEdges in packages/codemap/data/plan/cells.json`);
    }
  }
  if (!files) {
    for (const [name, row] of Object.entries(current.cells)) {
      const allowed = ceilings.cells[name] ?? { imports: [], deepImporters: 0 };
      if (name.startsWith('<-')) {
        if (row.deepImporters > allowed.deepImporters) add(`packages/${name.slice(2)}`, 1, `${row.deepImporters} files import ${name.slice(2)}'s src past its index (ceiling ${allowed.deepImporters}); import its index, or add "<from>->${name.slice(2)}/src" to allowedEdges in packages/codemap/data/plan/cells.json`);
        continue;
      }
      for (const target of row.imports.filter(to => !allowed.imports.includes(to))) add(`packages/${name}`, 1, `cell ${name} gains an edge to ${target}; cut it, or add "${name}->${target}" to allowedEdges in packages/codemap/data/plan/cells.json`);
    }
  }
  problems.push(...durableEdgeProblems(root, { files, ...(read ? { read } : {}), ...(edgesOf ? { edgesOf } : {}) }));
  return problems;
}

/**
 * Refuse each light door whose cold load is over its budget and slower than main's same door measured in the same run.
 * Why: a light door promises light-path code a cheap load; on a loaded machine main reads over budget too, so the
 * absolute budget alone backed out changes that never touched a door. Without a main tree to compare, the budget alone judges.
 * The measure starts child processes, so it runs here beside the edge check and never inside the synchronous leased audit.
 *
 * @param {string} root
 * @param {{ mainRoot?: string | null }} [options] - `mainRoot` is main's tree; null forces the budget alone, and the default finds the main checkout.
 * @returns {Promise<{ path: string, line: number, text: string }[]>}
 */
export async function lightDoorProblems(root, { mainRoot } = {}) {
  const problems = [];
  const against = mainRoot === null ? undefined : mainRoot ?? await mainRootOf(root);
  for (const door of lightDoorsOf(root)) {
    const { candidate: ms, main } = await measureAgainstMain(root, door, against);
    if (!lightDoorRefused(ms, main)) continue;
    const beside = main === undefined ? '' : `, and main measures ${main} ms beside it`;
    problems.push({ path: door, line: 1, text: `light door cold load ${Number.isFinite(ms) ? `${ms} ms` : 'fails'} exceeds its ${LIGHT_DOOR_BUDGET_MS} ms budget${beside}; drop the heavy re-export from ${door}, or move it behind the cell index` });
  }
  return problems;
}

/**
 * Refuse every backwards edge between the six durable cells: an import from one of them into another that its row in
 * DURABLE_CELLS does not allow. A plan declaration never allows one, so these edges are read before the plan filter.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (file: string) => string, edgesOf?: (file: string, source: string) => ReturnType<typeof fileEdges> }} [options] - `files` limits the check to those files (the pre-commit run).
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function durableEdgeProblems(root, { files, read = file => readFileSync(resolve(root, file), 'utf8'), edgesOf = fileEdges } = {}) {
  const problems = [];
  for (const file of (files ?? walk(root, SOURCE)).filter(path => SOURCE.test(path) && !TESTISH.test(path))) {
    const from = cellOf(file).cell;
    const allowed = DURABLE_CELLS[from];
    if (!allowed) continue;
    for (const edge of edgesOf(file, read(file))) {
      if (!Object.hasOwn(DURABLE_CELLS, edge.to) || allowed.includes(edge.to)) continue;
      problems.push({ path: file, line: edge.line, text: `backwards edge between durable cells: ${from} imports ${edge.to}; ${from} may import only ${allowed.join(', ') || 'none of the six'} (jobs, drive, transport, receipt, pin, land); move the code down a cell` });
    }
  }
  return problems;
}

/** Record the ceilings at today's undeclared counts, and each light door's measured cold load in ms. */
export async function writeCellsEdgeCeilings(root) {
  const lightDoors = {};
  for (const door of lightDoorsOf(root)) lightDoors[door] = await coldLoadMs(root, door);
  writeFileSync(CEILINGS, `${JSON.stringify({ ...ceilingsOf(cellsEdgeReport(root)), lightDoors }, null, 2)}\n`);
  return [];
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(process.argv.slice(2).find(argument => !['--report', '--write'].includes(argument)) ?? '.');
  if (process.argv.includes('--report')) console.log(JSON.stringify({ ...ceilingsOf(cellsEdgeReport(root)), durableCells: DURABLE_CELLS }, null, 2));
  else if (process.argv.includes('--write')) writeCellsEdgeCeilings(root).then(report);
  else lightDoorProblems(root).then(light => report([...cellsEdgeProblems(root), ...light]));
}
