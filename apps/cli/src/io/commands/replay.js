/** The pullboard replay command: how often a move table agrees with what the board recorded, read-only [C7,#8071]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { replayReport } from '../../../../../packages/moves/index.js';
import { context } from '../entry.js';

/**
 * Run `pullboard replay <table> [--days N]` and return its exit code.
 * Why read-only: judging a table must never change the board; the cell reads recorded moves through a read-only open.
 */
export async function run(io, { first, second, rest, values }) {
  if (second !== undefined || rest?.length) throw new Refused('USAGE', 'pullboard replay <table> [--days N] [--json] [--against <tag>]');
  const days = values.days === undefined ? 7 : Number(values.days);
  const ctx = context(io);
  const report = await replayReport({ root: ctx.info.root, boardFile: ctx.file, name: first, days, against: values.against });
  io.result?.(report);
  io.say(`replay ${report.table}: ${report.agreed} agreed, ${report.disagreed} disagreed, ${report.beforeCut} before the cut, ${report.notReplayable} not replayable (last ${report.days} days, cut ${report.cut})`);
  for (const miss of report.disagreements) io.say(`  event ${miss.event}: board ${describe(miss.recorded)}, table ${describe(miss.table)} (${miss.differs})`);
  if (report.judge) {
    io.say(`judge against ${report.judge.against}:`);
    for (const [name, count] of Object.entries(JUDGE_CLASS_COUNTS)) io.say(`  ${name}: ${report.judge.counts[count]}`);
    for (const row of report.judge.rows) io.say(`  event ${row.event}: ${row.class} (board ${describe(row.recorded)}, release ${describe(row.released)}, table ${describe(row.current)})`);
  }
  return 0;
}

/** The judge's four class names as printed, each with the count key that holds it. */
const JUDGE_CLASS_COUNTS = { same: 'same', 'current-drifted': 'currentDrifted', 'released-wrong': 'releasedWrong', 'both-differ': 'bothDiffer' };

/** One outcome in a line: a refusal's code, or the kinds of events written. */
function describe(outcome) {
  if (!outcome) return 'no answer';
  return outcome.decision === 'refused' ? `refused ${outcome.code}` : `accepted ${outcome.events.map(event => event.kind).join('+') || 'nothing'}`;
}
