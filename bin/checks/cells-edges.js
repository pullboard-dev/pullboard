#!/usr/bin/env node
/** Report cell import edges with --report, lower the ceilings with --write, or refuse an undeclared new cross-cell import or deep import [C7]. */
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lex,
  lineAt,
  report,
  walk,
} from './scan.js';

const CEILINGS = new URL('./cells-edges.json', import.meta.url);
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
  try { plan = JSON.parse(readFileSync(resolve(root, 'bin/cells-plan.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return new Set(plan.allowedEdges ?? []);
}

/**
 * Today's edges: per file the undeclared distinct cells and deep imports, and per cell the cells it imports and its deep importers.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (file: string) => string }} [options]
 * @returns {{ files: Record<string, { cells: number, deep: number, edges: { from: string, to: string, deep: boolean, line: number }[] }>, cells: Record<string, { imports: string[], deepImporters: number }> }}
 */
export function cellsEdgeReport(root, { files, read = file => readFileSync(resolve(root, file), 'utf8') } = {}) {
  const declared = declaredEdges(root);
  const names = (files ?? walk(root, SOURCE)).filter(file => SOURCE.test(file) && !TESTISH.test(file));
  const result = { files: {}, cells: {} };
  for (const file of names) {
    const from = cellOf(file).cell;
    const edges = fileEdges(file, read(file)).filter(edge => !declared.has(`${from}->${edge.to}${edge.deep ? '/src' : ''}`));
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
 * @param {{ files?: string[], read?: (file: string) => string, ceilings?: ReturnType<typeof ceilingsOf> }} [options] - `files` limits the check to those files (the pre-commit run).
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function cellsEdgeProblems(root, { files, read, ceilings = JSON.parse(readFileSync(CEILINGS, 'utf8')) } = {}) {
  const current = cellsEdgeReport(root, { files, read });
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
        ? `deep import into ${edge.to}'s src exceeds the ratchet (${row.deep} > ${allowed.deep}); import ${edge.to}'s index, or add "${declaration}" to allowedEdges in bin/cells-plan.json`
        : `new cross-cell import of ${edge.to} exceeds the ratchet (${row.cells} cells > ${allowed.cells}); cut it, or add "${declaration}" to allowedEdges in bin/cells-plan.json`);
    }
  }
  if (!files) {
    for (const [name, row] of Object.entries(current.cells)) {
      const allowed = ceilings.cells[name] ?? { imports: [], deepImporters: 0 };
      if (name.startsWith('<-')) {
        if (row.deepImporters > allowed.deepImporters) add(`packages/${name.slice(2)}`, 1, `${row.deepImporters} files import ${name.slice(2)}'s src past its index (ceiling ${allowed.deepImporters}); import its index, or add "<from>->${name.slice(2)}/src" to allowedEdges in bin/cells-plan.json`);
        continue;
      }
      for (const target of row.imports.filter(to => !allowed.imports.includes(to))) add(`packages/${name}`, 1, `cell ${name} gains an edge to ${target}; cut it, or add "${name}->${target}" to allowedEdges in bin/cells-plan.json`);
    }
  }
  problems.push(...durableEdgeProblems(root, { files, ...(read ? { read } : {}) }));
  return problems;
}

/**
 * Refuse every backwards edge between the six durable cells: an import from one of them into another that its row in
 * DURABLE_CELLS does not allow. A plan declaration never allows one, so these edges are read before the plan filter.
 *
 * @param {string} root
 * @param {{ files?: string[], read?: (file: string) => string }} [options] - `files` limits the check to those files (the pre-commit run).
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function durableEdgeProblems(root, { files, read = file => readFileSync(resolve(root, file), 'utf8') } = {}) {
  const problems = [];
  for (const file of (files ?? walk(root, SOURCE)).filter(path => SOURCE.test(path) && !TESTISH.test(path))) {
    const from = cellOf(file).cell;
    const allowed = DURABLE_CELLS[from];
    if (!allowed) continue;
    for (const edge of fileEdges(file, read(file))) {
      if (!Object.hasOwn(DURABLE_CELLS, edge.to) || allowed.includes(edge.to)) continue;
      problems.push({ path: file, line: edge.line, text: `backwards edge between durable cells: ${from} imports ${edge.to}; ${from} may import only ${allowed.join(', ') || 'none of the six'} (jobs, drive, transport, receipt, pin, land); move the code down a cell` });
    }
  }
  return problems;
}

/** Record the ceilings at today's undeclared counts. */
export function writeCellsEdgeCeilings(root) {
  writeFileSync(CEILINGS, `${JSON.stringify(ceilingsOf(cellsEdgeReport(root)), null, 2)}\n`);
  return [];
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(process.argv.slice(2).find(argument => !['--report', '--write'].includes(argument)) ?? '.');
  if (process.argv.includes('--report')) console.log(JSON.stringify({ ...ceilingsOf(cellsEdgeReport(root)), durableCells: DURABLE_CELLS }, null, 2));
  else if (process.argv.includes('--write')) report(writeCellsEdgeCeilings(root));
  else report(cellsEdgeProblems(root));
}
