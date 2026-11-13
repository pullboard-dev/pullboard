/** Retain canonical engine identities without allowing arbitrary accepted plan rows to disappear [C7,CD64]. */
import { cellLstatSync as lstatSync } from './cell/snapshot.js';
import { cellReadFileSync as readFileSync } from './cell/snapshot.js';
import { join } from 'node:path';
import { engineBindings } from '../../../kernel/index.js';
import { lex } from '../../../kernel/index.js';
import { Refused } from '../../../kernel/index.js';

const SUPPORT = new Set(['src/engine-next.js', 'src/engine-numbers.js', 'packages/state/src/io/engine/numbers.js',
  'packages/state/src/io/engine/metadata.js', 'packages/state/src/logic/move/constants.js']);
const HISTORY = /^(?:src\/move-history|packages\/state\/data\/history)\/(?:legacy|[1-9][0-9]*)\.json$/u;
const REASON = 'canonical engine identity retained in src during package moves';

/** Read only a regular canonical root leaf; symlinks cannot supply accepted source authority. */
function rootSource(root, file) {
  if (!/^src\/[A-Za-z0-9._-]+\.[cm]?js$/u.test(file) && !HISTORY.test(file) && !SUPPORT.has(file)) return null;
  try {
    const parents = file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    for (const parent of parents) {
      const directory = lstatSync(join(root, parent));
      if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
    }
    const stat = lstatSync(join(root, file));
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return readFileSync(join(root, file), 'utf8');
  } catch { return null; }
}

/** Include dangling targets: a missing destination is not permission to overwrite an alias. */
function present(root, file) {
  try { lstatSync(join(root, file)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Classify the accepted bytes, never a candidate-added declaration that would manufacture an exemption. */
function engineLeaf(row, source) {
  return source !== null && (SUPPORT.has(row[0]) || HISTORY.test(row[0])
    || engineBindings(lex(source).code).length > 0);
}

/** Validate exact row custody and unchanged new stays before the submit guard excuses a missing placement. */
export function engineStayTransition({ beforeRoot, afterRoot, before, after, afterMap }) {
  const problems = [], rows = new Set(), old = before.engineStays ?? [], next = after.engineStays ?? [];
  if (!Array.isArray(old) || !Array.isArray(next) || !Array.isArray(after.stays)) return { rows, problems: ['engine stays must be explicit row lists'] };
  const signature = entry => JSON.stringify(entry);
  for (const entry of old) if (!next.some(value => signature(value) === signature(entry))) {
    problems.push(`accepted engine-stay provenance changed: ${entry?.row?.[0]}`);
  }
  const seen = new Set();
  for (const entry of next) {
    const row = entry?.row, file = row?.[0];
    const owner = typeof entry?.cell === 'string' ? before.cells.find(cell => cell.name === entry.cell) : null;
    if (!entry || Object.keys(entry).sort().join(',') !== 'cell,row' || !owner || typeof owner.root !== 'string'
      || !Array.isArray(row) || row.length !== 3 || row.some(value => typeof value !== 'string')
      || !row[1].startsWith(`${owner.root}/`)) {
      problems.push(`engine stays need the exact original row under its own cell package: ${file}`); continue;
    }
    if (seen.has(file)) { problems.push(`duplicate engine stay: ${file}`); continue; }
    seen.add(file);
    const retained = old.some(value => signature(value) === signature(entry));
    const accepted = before.cells.find(cell => cell.name === entry.cell)?.paths.some(value => JSON.stringify(value) === JSON.stringify(row));
    const source = rootSource(beforeRoot, file), candidate = rootSource(afterRoot, file);
    const listed = after.stays.filter(value => value.path === file);
    const destinationPresent = present(afterRoot, row[1]);
    if ((!retained && (!accepted || !engineLeaf(row, source) || source !== candidate))
      || candidate === null || listed.length !== 1 || listed[0].reason !== REASON
      || after.cells.some(cell => cell.paths.some(value => value[0] === file))
      || afterMap.has(file) || destinationPresent) {
      problems.push(`unproven canonical engine stay: ${file}`); continue;
    }
    rows.add(file);
  }
  return { rows, problems };
}

/** Transfer only explicitly listed accepted engine rows to stays, preserving their exact original provenance. */
export function retainEnginePaths({ root, plan, cellName, paths, pathMap }) {
  if (typeof cellName !== 'string' || !cellName || !Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length) {
    throw new Refused('CELLS_ENGINE_STAY', 'List distinct engine paths with --engine-stays <cell> <path>... .');
  }
  const next = structuredClone(plan), cell = next.cells.find(value => value.name === cellName);
  if (!cell) throw new Refused('CELLS_ENGINE_STAY', 'Read the current plan entry for that cell before retaining its canonical engine paths.');
  next.engineStays ??= [];
  for (const file of paths) {
    const row = cell.paths.find(value => value[0] === file);
    if (!row || !engineLeaf(row, rootSource(root, file))) {
      throw new Refused('CELLS_ENGINE_STAY', `${file} is not a listed canonical engine leaf of that cell or approved engine support path.`);
    }
    next.engineStays.push({ cell: cellName, row: [...row] });
    next.stays.push({ path: file, reason: REASON });
    cell.paths = cell.paths.filter(value => value[0] !== file);
    cell.reexports = cell.reexports.filter(value => value !== file);
  }
  const checked = engineStayTransition({ beforeRoot: root, afterRoot: root, before: plan, after: next, afterMap: pathMap });
  if (checked.problems.length) throw new Refused('CELLS_ENGINE_STAY', checked.problems.join('; '));
  return next;
}
