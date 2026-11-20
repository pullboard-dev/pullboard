#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/** Report cells migration debt, or explicitly check/initialize/lower its root ratchet [C7,CD64]. */
import { dirname } from 'node:path';
import { fileSystemAdapter } from '../../../../../fs/index.js';
import { tryGit } from '../../../../../git/index.js';
import { resolve } from 'node:path';
import { readCellLintBaseline } from '../../../../index.js';
import { writeCellLintBaseline } from '../../../../index.js';
import { CELL_BASELINE_DESCRIPTOR } from '../../../../index.js';
import { cellLintCells } from '../../../../index.js';
import { storedCellLintFiles } from '../../../../index.js';
import { planCellLintBaseline } from '../../../../index.js';
import { cellLintReport } from '../../../../index.js';
import { cellLintBaseline } from '../../../../index.js';
import { cellLintGrowth } from '../../../../index.js';
import { checkCellLints } from '../../../../index.js';
import { lowerCellLintBaseline } from '../../../../index.js';
import { withCellLintParser } from '../../../../index.js';
import { cellLintParsers } from '../../../../index.js';

const fs = fileSystemAdapter();

withCellLintParser(compile => {
  const parsers = cellLintParsers(compile);
  const [mode = '--report', directory = '.'] = process.argv.slice(2);
  if (!['--report', '--check', '--init', '--update'].includes(mode) || process.argv.length > 4) {
    throw new Error('use node packages/codemap/src/io/cell/scripts/lints.js --report|--check|--init|--update [root]');
  }
  const root = resolve(directory), file = resolve(root, CELL_BASELINE_DESCRIPTOR);
  /** The lint report is the slow part; --check on an unchanged state never builds it [C7]. */
  const build = () => cellLintReport(root, parsers);
  const report = mode === '--check' ? null : build();
  if (mode === '--report') console.log(JSON.stringify({ ...report, growth: fs.exists(file) ? cellLintGrowth(report, readCellLintBaseline(root)) : null }, null, 2));
  else if (mode === '--init') {
    if (fs.exists(file)) throw new Error('a cell lint baseline already exists; use --update to lower it');
    const plan = planCellLintBaseline(report);
    // The cell inventory reads tracked files only, so the new shards are staged before the verify re-reads them [C7].
    const stage = () => { tryGit(root, ['add', '--', dirname(CELL_BASELINE_DESCRIPTOR)]); };
    writeCellLintBaseline(root, plan.baseline, { initialize: true, verify: () => { stage(); return JSON.stringify(cellLintBaseline(cellLintReport(root, parsers))) === JSON.stringify(plan.baseline); } });
  } else if (mode === '--update') {
    if (!fs.exists(file)) throw new Error('no cell lint baseline; explicitly review the report and initialize it with --init');
    const baseline = readCellLintBaseline(root);
    lowerCellLintBaseline(report, baseline);
    const sharded = cellLintCells(root).length > 0;
    const plan = sharded ? { baseline: cellLintBaseline(report), report } : planCellLintBaseline(report, storedCellLintFiles(root));
    lowerCellLintBaseline(plan.report, baseline);
    writeCellLintBaseline(root, plan.baseline, { previous: baseline, verify: () => JSON.stringify(cellLintBaseline(cellLintReport(root, parsers))) === JSON.stringify(plan.baseline) });
  } else {
    // --check holds this checkout to main's committed baseline, never to debt main merely carries now [C7,CD23].
    process.exitCode = checkCellLints(root, parsers, line => console.error(line), { code: [fileURLToPath(import.meta.url)] });
  }
});
