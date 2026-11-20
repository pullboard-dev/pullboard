#!/usr/bin/env node
/** Save the main CI performance artifacts and warn by action against the fixed view budgets [N40,C7]. */
import {
  join,
  resolve,
} from 'node:path';
import {
  evaluatePerfBudgets,
  perfBudgetTable,
  readPerfReport,
} from '../../../heavy.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** Parse the saved harness output; artifacts live outside the harness's disposable workspace. */
function main(args) {
  if (args.length !== 2) throw new Error('usage: node packages/gate/src/io/check/budgets.js <harness-output> <artifact-directory>');
  const report = readPerfReport(fs.readFile(resolve(args[0]), 'utf8'));
  const result = evaluatePerfBudgets(report);
  const directory = resolve(args[1]);
  fs.mkdir(directory, { recursive: true });
  fs.writeFile(join(directory, 'performance.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFile(join(directory, 'budgets.json'), JSON.stringify(result, null, 2) + '\n');
  const context = 'Measured board: ' + JSON.stringify(report.size) + ' items; ' + JSON.stringify(report.projects) + ' projects; ' + JSON.stringify(report.runs) + ' run(s).';
  fs.writeFile(join(directory, 'performance.md'), context + '\n\n' + perfBudgetTable(result) + '\n\n'
    + (typeof report.table === 'string' ? report.table + '\n' : ''));
  for (const warning of result.warnings) {
    // Names come only from the fixed action registry, so harness content cannot inject annotations.
    console.log('::warning::' + warning.name + ': median ' + warning.medianMs + ' ms (budget 100 ms), worst '
      + warning.worstMs + ' ms (budget 250 ms)');
  }
  for (const error of result.errors) console.error('perf budgets: ' + error);
  console.log('View interaction budgets: ' + result.interactions.length + ' checked, ' + result.warnings.length
    + ' warning(s); idleWithLiveWrites is a 30000 ms observation with no latency budget.');
  process.exitCode = result.errors.length ? 1 : 0;
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error('perf budgets: ' + (error instanceof SyntaxError ? 'invalid JSON or incomplete harness output' : error.message));
  process.exitCode = 1;
}
