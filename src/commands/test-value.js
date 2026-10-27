/** The requested fourteen-day test economics report [C7]. */
import {
  context,
  withBoardRead,
} from '../cli.js';
import { Refused } from '../refused.js';
import { testValueReport } from '../test-value.js';
import { readPlacementReport } from '../test-economics-index.js';

/** Print the same measurements in text or versioned JSON without recording a board move. */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => key !== 'json')) {
    throw new Refused('USAGE', 'pullboard test-value [--json] reports the last fourteen days');
  }
  const ctx = context(io);
  const report = withBoardRead(ctx, board => {
    board.db.exec('SAVEPOINT test_value_read');
    try { return testValueReport(board, { root: ctx.info.root, costs: ctx.config.testEconomics, now: ctx.clock.now().getTime() }); }
    finally { board.db.exec('RELEASE test_value_read'); }
  });
  report.placement = readPlacementReport(ctx.info.root);
  io.result?.({ report });
  io.say(`test value, ${report.since} to ${report.asOf} (14 days; highest value first)`);
  for (const row of report.files) io.say(`${row.file}: ${row.runs} runs; ${row.realCatches} code-fixed catches; ${row.flakes} flakes; runtime ${row.meanRuntimeMs === null ? (row.lastObservedRuntime ? `last observed ${row.lastObservedRuntime.durationMs}ms (${row.lastObservedRuntime.source}; age ${row.lastObservedRuntime.ageMs === null ? 'unknown' : `${row.lastObservedRuntime.ageMs}ms`})` : 'unknown') : `${row.meanRuntimeMs}ms/run`}; ${row.edits ?? 'unknown'} edits; value ${row.valuePerRun ?? 'unknown'} per run${row.estimatedValuePerRun === null ? '' : `; estimated value ${row.estimatedValuePerRun} from last observed runtime`}; ${row.timedRuns}/${row.runs} timed runs`);
  io.say(report.method);
  if (report.placement) {
    io.say(`recorded placement at ${report.placement.head}, ${report.placement.at}`);
    for (const row of report.placement.files) io.say(`${row.file}: ${row.tier}; ${row.reason}`);
  } else io.say('placement is not published yet; existing gates remain in force until the first audit');
  return 0;
}
