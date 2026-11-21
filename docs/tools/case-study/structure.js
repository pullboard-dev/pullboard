/** Measure physical migration debt using the real inventory and the cell folders [C7,D3]. */
import { importsIn } from '../../../packages/gate/heavy.js';
import { commonJsIn } from '../../../packages/gate/heavy.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cellInventory, testFile } from '../../../packages/codemap/index.js';
import { cellLintReport } from '../../../packages/codemap/index.js';
import { Refused } from '../../../packages/kernel/index.js';
import { tryGit } from '../../../packages/git/index.js';

/** The cells: each folder under apps and packages, with whether it has its front door. */
function cellsAt(root) {
  const cells = [];
  for (const group of ['apps', 'packages']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) cells.push({ name: entry.name, root: `${group}/${entry.name}`, frontDoor: existsSync(join(base, entry.name, 'index.js')) });
    }
  }
  return cells;
}

/** Identify the actual selected checkout independently of any earlier generation. */
function sourceAt(root) {
  const head = tryGit(root, ['rev-parse', 'HEAD']), tree = tryGit(root, ['rev-parse', 'HEAD^{tree}']);
  const status = tryGit(root, ['status', '--porcelain']);
  return { head: head.status === 0 ? head.stdout.trim() : null,
    tree: tree.status === 0 ? tree.stdout.trim() : null, clean: status.status === 0 && !status.stdout.trim() };
}

/** Count the cells, the production modules outside every cell and the lint debt; an unmapped file remains visible instead of earning a zero. */
export function structureMetrics(root) {
  const cells = cellsAt(root);
  const { edges, unknown } = cellInventory(root, { importsIn, commonJsIn }), unowned = new Set();
  for (const file of edges.keys()) {
    if (testFile(file)) continue;
    if (/^(?:src|packages|apps)\//u.test(file) && !cells.some(cell => file.startsWith(`${cell.root}/`))) unowned.add(file);
  }
  const lints = cellLintReport(root, { importsIn, commonJsIn });
  const counts = Object.fromEntries(Object.entries(lints.metrics).map(([name, metric]) => [name, metric.count]));
  return { source: sourceAt(root),
    cells: { total: cells.length, completed: cells.filter(cell => cell.frontDoor).length },
    lints: counts, unresolvedImports: unknown.length, unownedProductionModules: unowned.size,
    qualification: 'Cells are the folders under apps and packages; a cell counts as complete when it has its front door. Unresolved loaders and unowned modules are reported, not proven absent. Lint cycles count physical package/app cycles.' };
}

/** A finished structure requires every cell to have its front door and all measured debt to be gone, not a phase label. */
export function requireFinishedStructure(structure) {
  if (structure.cells.completed !== structure.cells.total
    || structure.lints.shims || structure.lints.cycles || structure.lints.legacySource
    || structure.unresolvedImports || structure.unownedProductionModules) {
    throw new Refused('CASE_STUDY_INCOMPLETE', 'the restructure still has measured debt; retain an in-progress report and finish the moves before recording a finished result');
  }
}
