/** Measure physical migration debt using the real inventory and committed plan [C7,D3]. */
import { importsIn } from '../../../packages/gate/heavy.js';
import { commonJsIn } from '../../../packages/gate/heavy.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellInventory, testFile } from '../../../packages/codemap/index.js';
import { cellLintReport } from '../../../packages/codemap/index.js';
import { readPathMap, mappedPath } from '../../../packages/codemap/index.js';
import { Refused } from '../../../packages/kernel/index.js';
import { tryGit } from '../../../packages/git/index.js';
import { lex } from '../../../packages/kernel/index.js';
import { createHash } from 'node:crypto';
import { readPlan } from '../../../packages/codemap/index.js';

/** Read the indexed plan without regenerating it or changing any ratchet. */
function planAt(root) {
  const digest = createHash('sha256');
  let first = true;
  const plan = readPlan(root, file => {
    const bytes = readFileSync(join(root, file));
    digest.update(`${first ? '' : '\0'}${file}\0`).update(bytes);
    first = false;
    return bytes.toString('utf8');
  });
  return { ...plan, contentSHA256: digest.digest('hex') };
}

/** Identify the actual selected checkout independently of the plan's earlier generation seed. */
function sourceAt(root) {
  const head = tryGit(root, ['rev-parse', 'HEAD']), tree = tryGit(root, ['rev-parse', 'HEAD^{tree}']);
  const status = tryGit(root, ['status', '--porcelain']);
  return { head: head.status === 0 ? head.stdout.trim() : null,
    tree: tree.status === 0 ? tree.stdout.trim() : null, clean: status.status === 0 && !status.stdout.trim() };
}

/** Count actual later-cell imports; an unmapped file remains visible instead of earning a zero. */
export function structureMetrics(root, { planRoot = root } = {}) {
  const plan = planAt(planRoot), map = readPathMap(root), owners = new Map();
  for (const cell of plan.cells) {
    owners.set(cell.frontDoor, cell);
    for (const [from, to] of cell.paths) for (const path of [from, to, mappedPath(map, from)]) owners.set(path, cell);
  }
  /** New definitions under an owning package have the same identity before the rest of its move. */
  function owner(path) { return plan.cells.find(cell => path.startsWith(`${cell.root}/`)) ?? owners.get(path); }
  const { files, edges, unknown } = cellInventory(root, { importsIn, commonJsIn }), cuts = [], unowned = new Set();
  for (const [file, imports] of edges) {
    if (testFile(file)) continue;
    const from = owner(file);
    if (!from && /^(?:src|packages|apps)\//u.test(file)) unowned.add(file);
    for (const { target } of imports) {
      if (testFile(target)) continue;
      const to = owner(target);
      if (from && to && from.order < to.order) cuts.push({ from: file, to: target, cell: from.name, target: to.name });
    }
  }
  const lints = cellLintReport(root, { importsIn, commonJsIn });
  /** A move behind a transparent shim is complete even though removing that shim is still separate debt. */
  function remainingBody(from, to) {
    if (!existsSync(join(root, to))) return true;
    if (!files.has(from)) return false;
    if (!/\.[cm]?js$/u.test(from)) return true;
    const code = lex(files.get(from).toString('utf8')).code.replace(/\s/gu, '');
    return !/^(?:export(?:\*|\{[^}]*\})from(?:''|"");)+$/u.test(code);
  }
  const counts = Object.fromEntries(Object.entries(lints.metrics).map(([name, metric]) => [name, metric.count]));
  const cells = plan.cells.map(cell => ({ name: cell.name, paths: cell.paths.length,
    remaining: cell.paths.filter(([from, to]) => remainingBody(from, to)).length,
    frontDoor: existsSync(join(root, cell.frontDoor)) }));
  return { source: sourceAt(root), planSource: { ...sourceAt(planRoot), contentSHA256: plan.contentSHA256 },
    importCutsLeft: cuts.length, plannedCutImports: plan.totals.cutImports, planBase: plan.base,
    cells: { total: cells.length, completed: cells.filter(cell => !cell.remaining && cell.frontDoor).length,
      remainingPaths: cells.reduce((sum, cell) => sum + cell.remaining, 0) },
    lints: counts, unresolvedImports: unknown.length, unownedProductionModules: unowned.size,
    qualification: 'Import occurrences use physical non-test imports and committed plan ownership/order, including new files in cell roots. A body moved behind a transparent shim counts as a completed move; shim removal remains separate measured debt. Unresolved loaders and unowned modules are reported, not proven absent. Lint cycles count physical package/app cycles; a flat source tree can have zero physical cycles while planned cuts remain.' };
}

/** A finished structure requires every planned move and actual debt to be gone, not a phase label. */
export function requireFinishedStructure(structure) {
  if (structure.cells.completed !== structure.cells.total || structure.cells.remainingPaths
    || structure.importCutsLeft || structure.lints.shims || structure.lints.cycles || structure.lints.legacySource
    || structure.unresolvedImports || structure.unownedProductionModules) {
    throw new Refused('CASE_STUDY_INCOMPLETE', 'the restructure still has measured debt; retain an in-progress report and finish the moves before recording a finished result');
  }
}
