import { readCarryingCapacity } from '../../../../../packages/stats/index.js';
import { flowWindowMinutes } from '../../../../../packages/stats/index.js';
import { buildCalibration } from '../../../../../packages/stats/index.js';
import { events } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
import { flakeLedger } from '../../../../../packages/flakes/index.js';
import { eventCauses } from '../../../../../packages/store/index.js';
/** Observed test-work cost and explicit boundary inventory, without changing admission [C7]. */
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { testCapacityReport } from '../../../../../packages/gate/index.js';

/** Keep missing evidence visible in text just as null remains visible in JSON. */
function minutes(value) { return value === null ? 'unknown' : `${value.toFixed(3)} min`; }

/** Print measurements and conversion proposals; removal always needs the person's approval. */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => !['json', 'window', 'detail'].includes(key))) {
    throw new Refused('USAGE', 'use pullboard capacity [--window 14d] [--json] to read carrying capacity and test execution work');
  }
  const ctx = context(io);
  const to = ctx.clock.now().toISOString();
  const from = new Date(Date.parse(to) - flowWindowMinutes(values.window ?? '14d') * 60_000).toISOString();
  const report = withBoardRead(ctx, board => {
    board.db.exec('SAVEPOINT capacity_read');
    try { const tests = testCapacityReport(board, { root: ctx.info.root, costs: ctx.config.testEconomics, now: ctx.clock.now().getTime() }, { flakeLedger, eventCauses, gateRuns });
      const history = events(board);
      return { ...tests, builds: buildCalibration(history, listItems(board, { all: true }), ctx.config.itemBuildBudgetMinutes),
        carryingCapacity: readCarryingCapacity(ctx.info.root, history, { from, to }) }; }
    finally { board.db.exec('RELEASE capacity_read'); }
  });
  io.result?.({ report });
  const carrying = report.carryingCapacity;
  if (!values.detail) {
    io.say(`carrying capacity ${from} to ${to}: ${carrying.landings} landings, ${carrying.conflicts} conflicts`);
    io.say(`model: k ${carrying.k ?? 'unknown'}; 5% line ${carrying.agentsAtFivePercent ?? 'unknown'} agents; peak ${carrying.peakAgents ?? 'unknown'} agents, ${carrying.peakOutput ?? 'unknown'} output`);
    io.say(`in flight ${carrying.inFlight ?? 'unknown'}: building ${carrying.buildingInFlight ?? 'unknown'}, waiting ${carrying.waitingInFlight ?? 'unknown'}; cells/item ${carrying.cellsPerItem ?? 'unknown'}`);
    io.say(`held-out file conflicts: predicted ${carrying.validation.predictedFileConflicts ?? 'unknown'}, actual ${carrying.validation.actualFileConflicts}; relative error ${carrying.validation.relativeError ?? 'unknown'}`);
    io.say(`item build budget: ${report.builds.budgetMinutes} min; ${report.builds.calibration.samples} samples`);
    for (const row of report.builds.items.filter(item => item.expectedMinutes !== null)) io.say(`#${row.item} build: expected ${minutes(row.expectedMinutes)}; actual ${minutes(row.actualMinutes)}; ratio ${row.ratio === null ? 'unknown' : row.ratio.toFixed(3)}`);
    io.say(`test-work: suite ${minutes(report.suite.minutes)}; per landing ${minutes(report.perLanding.minutes)}; ${report.perLanding.missingExecutions} missing executions, ${report.perLanding.unknownReceipts} unknown receipts`);
    io.say(`file classes: ${report.files.pure} pure, ${report.files.contract} contract, ${report.files.unknown} unknown; assumptions and cost details: --detail`);
    return 0;
  }
  io.say(`carrying capacity ${from} to ${to}: ${carrying.landings} landings, ${carrying.conflicts} conflicts; conflicts/landing ${carrying.conflictsPerLanding ?? 'unknown'}`);
  io.say(`collision k ${carrying.k ?? 'unknown'}; 5% line ${carrying.agentsAtFivePercent ?? 'unknown'} agents; model peak ${carrying.peakAgents ?? 'unknown'} agents, ${carrying.peakOutput ?? 'unknown'} output`);
  io.say(`changes in flight ${carrying.inFlight ?? 'unknown'}: building ${carrying.buildingInFlight ?? 'unknown'}, waiting ${carrying.waitingInFlight ?? 'unknown'}; cells/item ${carrying.cellsPerItem ?? 'unknown'}`);
  io.say(`held-out file conflicts: predicted ${carrying.validation.predictedFileConflicts ?? 'unknown'}, actual ${carrying.validation.actualFileConflicts}; relative error ${carrying.validation.relativeError ?? 'unknown'}`);
  for (const file of carrying.files.slice(0, 10)) io.say(`${file.file}: shared touches ${file.sharedTouches ?? 'unknown'}, conflict rate ${file.rate ?? 'unknown'}, pressure ${file.pressure ?? 'unknown'}`);
  for (const assumption of carrying.assumptions) io.say(assumption);
  io.say(`item build budget: ${report.builds.budgetMinutes} min; ${report.builds.calibration.samples} expected/actual samples`);
  for (const row of report.builds.items.filter(item => item.expectedMinutes !== null)) io.say(`#${row.item} build: expected ${minutes(row.expectedMinutes)}; actual ${minutes(row.actualMinutes)}; ratio ${row.ratio === null ? 'unknown' : row.ratio.toFixed(3)}`);
  io.say(`suite test-work: ${minutes(report.suite.minutes)} (serial per-file execution work, not parallel elapsed wall time)`);
  if (report.suite.unavailableReason) io.say(report.suite.unavailableReason);
  io.say(`test-work per landing: ${minutes(report.perLanding.minutes)} (${report.perLanding.landings} landing units: explicit batches or unmatched distinct merge commits; batch grouping unknown for the latter; known subtotal ${minutes(report.perLanding.knownMinutes)}; ${report.perLanding.missingExecutions} missing executions; ${report.perLanding.unknownReceipts} unknown-file receipts)`);
  io.say(`declared pure/contract-only share: ${report.files.pure + report.files.contract}/${report.files.total}; ${report.files.unknown} unknown files (lower bound)`);
  io.say(report.conversion.basis);
  for (const row of report.conversion.order) io.say(`${row.file}: ${row.runtimeMs}ms; ${row.realCatches} recorded catches; ${row.proposal}`);
  return 0;
}
