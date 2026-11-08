#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/** Report cells migration debt, or explicitly check/initialize/lower its root ratchet [C7,CD64]. */
import { importsWithCompiler } from '../packages/kernel/index.js';
import { commonJsWithCompiler } from '../packages/kernel/index.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { CELL_BASELINE_DESCRIPTOR } from '../packages/codemap/index.js';
import { cellLintCells } from '../packages/codemap/index.js';
import { storedCellLintFiles } from '../packages/codemap/index.js';
import { planCellLintBaseline } from '../packages/codemap/index.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { cellLintGrowth } from '../packages/codemap/index.js';
import { strayNextStep } from '../packages/codemap/index.js';
import { mainCommit } from '../packages/codemap/index.js';
import { mainCellLintReport } from '../packages/codemap/index.js';
import { lowerCellLintBaseline } from '../packages/codemap/index.js';
import { withCellLintParser } from '../packages/codemap/index.js';
import { cachedCellsRun } from '../packages/codemap/index.js';

withCellLintParser(compile => {
  const parsers = { importsIn: sources => importsWithCompiler(sources, compile), commonJsIn: sources => commonJsWithCompiler(sources, compile) };
  const [mode = '--report', directory = '.'] = process.argv.slice(2);
  if (!['--report', '--check', '--init', '--update'].includes(mode) || process.argv.length > 4) {
    throw new Error('use node bin/cell-lints.js --report|--check|--init|--update [root]');
  }
  const root = resolve(directory), file = resolve(root, CELL_BASELINE_DESCRIPTOR);
  /** The lint report is the slow part; --check on an unchanged state never builds it [C7]. */
  const build = () => cellLintReport(root, parsers);
  const report = mode === '--check' ? null : build();
  if (mode === '--report') console.log(JSON.stringify({ ...report, growth: existsSync(file) ? cellLintGrowth(report, readCellLintBaseline(root)) : null }, null, 2));
  else if (mode === '--init') {
    if (existsSync(file)) throw new Error('a cell lint baseline already exists; use --update to lower it');
    const plan = planCellLintBaseline(report);
    writeCellLintBaseline(root, plan.baseline, { initialize: true, verify: () => JSON.stringify(cellLintBaseline(cellLintReport(root, parsers))) === JSON.stringify(plan.baseline) });
  } else if (mode === '--update') {
    if (!existsSync(file)) throw new Error('no cell lint baseline; explicitly review the report and initialize it with --init');
    const baseline = readCellLintBaseline(root);
    lowerCellLintBaseline(report, baseline);
    const sharded = cellLintCells(root).length > 0;
    const plan = sharded ? { baseline: cellLintBaseline(report), report } : planCellLintBaseline(report, storedCellLintFiles(root));
    lowerCellLintBaseline(plan.report, baseline);
    writeCellLintBaseline(root, plan.baseline, { previous: baseline, verify: () => JSON.stringify(cellLintBaseline(cellLintReport(root, parsers))) === JSON.stringify(plan.baseline) });
  } else {
    // --check counts current main and this checkout now; no committed baseline must match either [C7].
    const main = mainCommit(root);
    process.exitCode = cachedCellsRun(root, ['cell-lints', mode, main ?? 'no-main'], () => {
      const current = build(), base = mainCellLintReport(root, parsers, main);
      if (!base) { console.error('no main branch to compare with; nothing can rise'); return 0; }
      // Advisory transition authority comes only from main, as in the submit check.
      current.transition = base.report.transition;
      const problems = cellLintGrowth(current, base.baseline);
      for (const row of problems) console.error(`${row.advisory ? `advisory item #${row.item} until #${row.until}: ` : ''}${row.metric}:${row.key}: ${row.actual} exceeds ${row.allowed} on main ${base.commit.slice(0, 12)}${row.metric === 'strays' ? `; next: ${strayNextStep(row.key)}` : ''}`);
      return problems.some(row => !row.advisory) ? 1 : 0;
    }, { code: [fileURLToPath(import.meta.url), fileURLToPath(new URL('../packages/codemap/src/shell/main-cell-lints.js', import.meta.url))] });
  }
});
