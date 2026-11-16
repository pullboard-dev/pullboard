/** The pullboard mutate command: seed single-line faults into a throwaway copy of a cell and say which of its tests catch them; report only [C7]. */
import { mutateCell } from '../mutate/run.js';
import { score } from '../../logic/mutate/score.js';
import { scoreText } from '../../logic/mutate/score.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Needs no board: it reads git and the cell folder only. */
export const nativeBoardRequired = false;

/**
 * Run `pullboard mutate <cell> [--all] [--item <id>]` and return its exit code, 0 even when faults were missed: it reports, it never gates.
 * Why --all is separate: the default seeds only lines changed against main, which keeps a check short; --all seeds every line; --item writes the per-kind score onto that item.
 */
export async function run(io, { first, second, values }) {
  if (!first || second) throw new Refused('USAGE', 'use pullboard mutate <cell folder> [--all] [--item <id>]', 'pullboard mutate packages/search');
  // A stop (Ctrl-C or a kill) must end the test children too, or they outlive the run as orphans [#8500].
  const stopper = new AbortController();
  const stop = () => stopper.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let report;
  try {
    report = await mutateCell(io.cwd, first, { all: Boolean(values?.all), signal: stopper.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  io.result?.(report);
  for (const file of report.redBefore) io.say(`red-before  ${file}  fails unmutated; left out`);
  for (const fault of report.faults) {
    io.say(`${fault.caught ? 'caught' : 'missed'}  ${report.cell}/${fault.file}:${fault.line}  ${fault.operator}  ${fault.before.trim()}  ->  ${fault.after.trim()}${fault.caught ? `  by ${fault.caughtBy.join(', ')}` : ''}`);
  }
  for (const test of report.tests) io.say(`test  ${test.file}  caught ${test.caught} of ${test.total}`);
  const rows = score(report);
  for (const row of rows) io.say(`score  ${row.kind}  caught ${row.caught} of ${row.seeded}`);
  io.say(`${report.caught} of ${report.faults.length} faults caught in ${report.cell}${report.all ? '' : ` (lines changed against ${report.base})`}`);
  if (values?.item !== undefined && rows.length) {
    // The score goes on the item as a measurement fact; the board loads only now, so a plain run still needs none.
    await io.prepareProcessPorts();
    io.nativeBoard ??= await io.loadNativeBoard();
    const { run: addFact } = await import('./fact.js');
    const recorded = await addFact(io, { first: String(values.item), second: 'measurement', rest: [scoreText(report.cell, rows)], values: {} });
    if (recorded !== 0) return recorded;
  }
  return 0;
}
