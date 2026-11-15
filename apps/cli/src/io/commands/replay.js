/** The pullboard replay command: how often a move table agrees with what the board recorded, read-only [C7,#8071]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { replayReport } from '../../../../../packages/moves/index.js';
import { context } from '../entry.js';

/**
 * Run `pullboard replay <table> [--days N]` and return its exit code.
 * Why read-only: judging a table must never change the board; the cell reads recorded moves through a read-only open.
 */
export async function run(io, { first, second, rest, values }) {
  if (second !== undefined || rest?.length) throw new Refused('USAGE', 'pullboard replay <table> [--days N] [--json]');
  const days = values.days === undefined ? 7 : Number(values.days);
  const ctx = context(io);
  const report = await replayReport({ root: ctx.info.root, boardFile: ctx.file, name: first, days });
  io.result?.(report);
  io.say(`replay ${report.table}: ${report.agreed} agreed, ${report.disagreed} disagreed, ${report.beforeCut} before the cut, ${report.notReplayable} not replayable (last ${report.days} days, cut ${report.cut})`);
  for (const miss of report.disagreements) io.say(`  event ${miss.event}: board ${describe(miss.recorded)}, table ${describe(miss.table)} (${miss.differs})`);
  return 0;
}

/** One outcome in a line: a refusal's code, or the kinds of events written. */
function describe(outcome) {
  return outcome.decision === 'refused' ? `refused ${outcome.code}` : `accepted ${outcome.events.map(event => event.kind).join('+') || 'nothing'}`;
}
