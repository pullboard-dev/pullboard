import { existsSync } from 'node:fs';
import { git } from '../packages/git/index.js';
import { join } from 'node:path';
import { warmAcceptedCells } from '../packages/gate/index.js';
import { readAcceptedCells } from '../packages/gate/index.js';
import { recordAcceptedCellsFailure } from '../packages/gate/index.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { withFileLock } from '../packages/outbox/index.js';
import { checkCuts } from './cells-plan-cuts.js';
import { readPlan } from './cells-plan.js';

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Create the main-audit service that reuses or off-path warms a pinned accepted inventory. */
export function cellsBacklogCollector(root) {
  /** Load exact accepted inventory, compute cuts, and log findings only from main-audit execution. */
  async function collectCellsBacklog(source, job) {
    if (!existsSync(join(source, 'bin/cells-plan.json'))) return null;
    let artifact = readAcceptedCells(root, job.tip);
    if (!artifact.available) {
      try { artifact = await warmAcceptedCells(root, job.tip, { withCheckout: withMainCheckout, withLock: withFileLock }); }
      catch (error) { try { recordAcceptedCellsFailure(root, job.tip, error); } catch { /* Preserve the producer failure. */ } throw error; }
    }
    const backlog = cellsAuditBacklog(source, job, artifact);
    if (backlog?.count) {
      process.stdout.write('cell cuts backlog:\n');
      for (const cell of backlog.cells) for (const cut of cell.cuts) process.stdout.write(`  ${cell.name} --cuts: ${cut}\n`);
    }
    return backlog;
  }
  return collectCellsBacklog;
}

/** Collect every accepted cell's current import-cut backlog from a pinned main audit source. */
export function cellsAuditBacklog(source, job, artifact) {
  if (!HASH.test(job?.tip ?? '') || !HASH.test(job?.tree ?? '')
    || git(source, ['rev-parse', 'HEAD']) !== job.tip || git(source, ['rev-parse', 'HEAD^{tree}']) !== job.tree
    || git(source, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('main audit cut backlog needs the exact clean pinned source');
  if (!existsSync(join(source, 'bin/cells-plan.json'))) return null;
  if (!HASH.test(job?.tip ?? '') || !HASH.test(job?.tree ?? '') || artifact?.available !== true
    || artifact.descriptor?.tree !== job.tree || !(artifact.inventory?.files instanceof Map)
    || !(artifact.inventory?.edges instanceof Map) || !Array.isArray(artifact.inventory?.unknown)) {
    throw new Error('main audit cut backlog needs the actual accepted inventory for its pinned tree');
  }
  const plan = readPlan(source);
  const cells = plan.cells.map(cell => ({
    name: cell.name,
    cuts: checkCuts(source, plan, cell.name, { allLaterCells: true, temporaryExceptions: false,
      inventory: artifact.inventory, acceptedInventory: artifact.inventory }),
  }));
  const count = cells.reduce((total, cell) => total + cell.cuts.length, 0);
  return { version: 1, tip: job.tip, tree: job.tree, cells, count };
}
