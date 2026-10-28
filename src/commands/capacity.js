/** Observed test-work cost and explicit boundary inventory, without changing admission [C7]. */
import { context } from '../cli.js';
import { withBoardRead } from '../cli.js';
import { Refused } from '../refused.js';
import { testCapacityReport } from '../test-capacity.js';

/** Keep missing evidence visible in text just as null remains visible in JSON. */
function minutes(value) { return value === null ? 'unknown' : `${value.toFixed(3)} min`; }

/** Print measurements and conversion proposals; removal always needs the person's approval. */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => key !== 'json')) {
    throw new Refused('USAGE', 'use pullboard capacity [--json] to read test execution work and conversion priority');
  }
  const ctx = context(io);
  const report = withBoardRead(ctx, board => {
    board.db.exec('SAVEPOINT capacity_read');
    try { return testCapacityReport(board, { root: ctx.info.root, costs: ctx.config.testEconomics, now: ctx.clock.now().getTime() }); }
    finally { board.db.exec('RELEASE capacity_read'); }
  });
  io.result?.({ report });
  io.say(`suite test-work: ${minutes(report.suite.minutes)} (serial per-file execution work, not parallel elapsed wall time)`);
  if (report.suite.unavailableReason) io.say(report.suite.unavailableReason);
  io.say(`test-work per landing: ${minutes(report.perLanding.minutes)} (${report.perLanding.landings} landing units: explicit batches or unmatched distinct merge commits; batch grouping unknown for the latter; known subtotal ${minutes(report.perLanding.knownMinutes)}; ${report.perLanding.missingExecutions} missing executions; ${report.perLanding.unknownReceipts} unknown-file receipts)`);
  io.say(`declared pure/contract-only share: ${report.files.pure + report.files.contract}/${report.files.total}; ${report.files.unknown} unknown files (lower bound)`);
  io.say(report.conversion.basis);
  for (const row of report.conversion.order) io.say(`${row.file}: ${row.runtimeMs}ms; ${row.realCatches} recorded catches; ${row.proposal}`);
  return 0;
}
