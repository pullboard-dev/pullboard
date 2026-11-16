/** The pullboard explain command: a move table's guards in order with each refusal code and next step, read-only [C7,#8072]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { explainReport } from '../../../../../packages/moves/index.js';
import { context } from '../entry.js';

/** Run `pullboard explain <table>` and return its exit code. Why: an agent asks "what can happen from here" without reading the table's source. */
export async function run(io, { first, second, rest }) {
  if (second !== undefined || rest?.length) throw new Refused('USAGE', 'pullboard explain <table> [--json]');
  const report = await explainReport({ root: context(io).info.root, name: first });
  io.result?.(report);
  io.say(`table ${report.table}`);
  if (!report.guards.length) io.say('  no guards');
  for (const guard of report.guards) io.say(`  ${guard.order}. ${guard.id}: needs ${guard.says}; else ${guard.code}, next: ${guard.next}`);
  for (const outcome of report.outcomes) io.say(`  outcome ${outcome.id}: ${outcome.says}`);
  for (const followup of report.followups) io.say(`  then ${followup.id}: ${followup.says}`);
  return 0;
}
