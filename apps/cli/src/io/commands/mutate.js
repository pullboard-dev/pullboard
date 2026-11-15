/** The pullboard mutate command: seed single-line faults into a throwaway copy of a cell and say which of its tests catch them; report only [C7]. */
import { mutateCell } from '../mutate/run.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Needs no board: it reads git and the cell folder only. */
export const nativeBoardRequired = false;

/**
 * Run `pullboard mutate <cell> [--all]` and return its exit code, 0 even when faults were missed: it reports, it never gates.
 * Why --all is separate: the default seeds only lines changed against main, which keeps a check short; --all seeds every line.
 */
export async function run(io, { first, second, values }) {
  if (!first || second) throw new Refused('USAGE', 'use pullboard mutate <cell folder> [--all]', 'pullboard mutate packages/search');
  const report = await mutateCell(io.cwd, first, { all: Boolean(values?.all) });
  io.result?.(report);
  for (const file of report.redBefore) io.say(`red-before  ${file}  fails unmutated; left out`);
  for (const fault of report.faults) {
    io.say(`${fault.caught ? 'caught' : 'missed'}  ${report.cell}/${fault.file}:${fault.line}  ${fault.operator}  ${fault.before.trim()}  ->  ${fault.after.trim()}${fault.caught ? `  by ${fault.caughtBy.join(', ')}` : ''}`);
  }
  for (const test of report.tests) io.say(`test  ${test.file}  caught ${test.caught} of ${test.total}`);
  io.say(`${report.caught} of ${report.faults.length} faults caught in ${report.cell}${report.all ? '' : ` (lines changed against ${report.base})`}`);
  return 0;
}
