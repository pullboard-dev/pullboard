#!/usr/bin/env node
/** Report cells migration debt, or explicitly check/initialize/lower its root ratchet [C7,CD64]. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCellLintBaseline } from '../src/cell-lint-store.js';
import { writeCellLintBaseline } from '../src/cell-lint-store.js';
import { CELL_BASELINE_DESCRIPTOR } from '../src/cell-lint-store.js';
import { storedCellLintFiles } from '../src/cell-lint-store.js';
import { planCellLintBaseline } from '../src/cell-lint-baseline-plan.js';
import { cellLintReport } from '../src/cell-lints.js';
import { cellLintBaseline } from '../src/cell-lint-ratchet.js';
import { cellLintGrowth } from '../src/cell-lint-ratchet.js';
import { lowerCellLintBaseline } from '../src/cell-lint-ratchet.js';

const [mode = '--report', directory = '.'] = process.argv.slice(2);
if (!['--report', '--check', '--init', '--update'].includes(mode) || process.argv.length > 4) {
  throw new Error('use node bin/cell-lints.js --report|--check|--init|--update [root]');
}
const root = resolve(directory), file = resolve(root, CELL_BASELINE_DESCRIPTOR), report = cellLintReport(root);
if (mode === '--report') console.log(JSON.stringify({ ...report, growth: existsSync(file) ? cellLintGrowth(report, readCellLintBaseline(root)) : null }, null, 2));
else if (mode === '--init') {
  if (existsSync(file)) throw new Error('a cell lint baseline already exists; use --update to lower it');
  const plan = planCellLintBaseline(report);
  writeCellLintBaseline(root, plan.baseline, { initialize: true, verify: () => JSON.stringify(cellLintBaseline(cellLintReport(root))) === JSON.stringify(plan.baseline) });
} else {
  if (!existsSync(file)) throw new Error('no cell lint baseline; explicitly review the report and initialize it with --init');
  const baseline = readCellLintBaseline(root);
  if (mode === '--update') {
    lowerCellLintBaseline(report, baseline);
    const plan = planCellLintBaseline(report, storedCellLintFiles(root));
    lowerCellLintBaseline(plan.report, baseline);
    writeCellLintBaseline(root, plan.baseline, { previous: baseline, verify: () => JSON.stringify(cellLintBaseline(cellLintReport(root))) === JSON.stringify(plan.baseline) });
  }
  else {
    const problems = cellLintGrowth(report, baseline);
    for (const row of problems) console.error(`${row.advisory ? `advisory item #${row.item} until #${row.until}: ` : ''}${row.metric}:${row.key}: ${row.actual} exceeds ${row.allowed}`);
    process.exitCode = problems.some(row => !row.advisory) ? 1 : 0;
  }
}
