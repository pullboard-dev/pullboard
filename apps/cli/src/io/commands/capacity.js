import { readCarryingCapacity } from '../../../../../packages/stats/index.js';
import { flowWindowMinutes } from '../../../../../packages/stats/index.js';
import { buildCalibration } from '../../../../../packages/stats/index.js';
import { predictionAccuracy } from '../../../../../packages/stats/index.js';
import { predictionLine } from '../../../../../packages/stats/index.js';
import { predictedFiles } from '../../../../../packages/items/index.js';
import { events } from '../../../../../packages/store/index.js';
import { capacityWeekRow } from '../../../../../packages/stats/index.js';
import { capacityWeeks } from '../../../../../packages/store/index.js';
import { recordCapacityWeek } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
import { flakeLedger } from '../../../../../packages/flakes/index.js';
import { eventCauses } from '../../../../../packages/store/index.js';
/** Observed test-work cost and explicit boundary inventory, without changing admission [C7]. */
import { context } from '../entry.js';
import { withBoard } from '../entry.js';
import { withBoardRead } from '../entry.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { testCapacityReport } from '../../../../../packages/gate/index.js';
import { readFileTimes } from '../../../../../packages/gate/index.js';
import { fileTimesCoverage } from '../../../../../packages/gate/index.js';
import { fileTimesCoverageNote } from '../../../../../packages/gate/index.js';
import { trackedDefaultTestFiles } from '../../../../../packages/gate/index.js';
import { pushGateReport } from '../hook/push.js';
import { liveRunnerCount } from './runner.js';

/** Read the push gate's sizing inputs without writing; unknown inputs stay null so the report never invents a zero. */
function pushGateView(ctx) {
  let files = null;
  let times = {};
  try { files = trackedDefaultTestFiles(ctx.info.root, process.env); times = readFileTimes(ctx.info.root); } catch { /* files stay unknown */ }
  return { ...pushGateReport(files, times, ctx.config, liveRunnerCount(ctx)), ...(files ? { timeCoverage: fileTimesCoverage(ctx.info.root, files, times) } : {}) };
}

/** Keep missing evidence visible in text just as null remains visible in JSON. */
function minutes(value) { return value === null ? 'unknown' : `${value.toFixed(3)} min`; }

/** Print measurements and conversion proposals; removal always needs the person's approval. */
export async function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => !['json', 'window', 'detail', 'audit'].includes(key))) {
    throw new Refused('USAGE', 'use pullboard capacity [--window 14d] [--json] [--detail|--audit] to read carrying capacity and test execution work');
  }
  if (values.audit) return (await import('../capacity-audit.js')).runAudit(io, values, gateRuns);
  const ctx = context(io);
  const to = ctx.clock.now().toISOString();
  const from = new Date(Date.parse(to) - flowWindowMinutes(values.window ?? '14d') * 60_000).toISOString();
  const report = withBoardRead(ctx, board => {
    board.db.exec('SAVEPOINT capacity_read');
    try { const tests = testCapacityReport(board, { root: ctx.info.root, costs: ctx.config.testEconomics, now: ctx.clock.now().getTime() }, { flakeLedger, eventCauses, gateRuns });
      const history = events(board);
      const items = listItems(board, { all: true });
      return { ...tests, builds: buildCalibration(history, items, ctx.config.itemBuildBudgetMinutes), predictions: predictionAccuracy(history, items, predictedFiles),
        carryingCapacity: readCarryingCapacity(ctx.info.root, history, { from, to }), pushGate: pushGateView(ctx) }; }
    finally { board.db.exec('RELEASE capacity_read'); }
  });
  // One row per ISO week: a reading over the week to date, written over the week's earlier row, never beside it.
  const weekFrom = new Date(Date.parse(to) - 7 * 86_400_000).toISOString();
  const weekly = weekFrom === from ? report.carryingCapacity : withBoardRead(ctx, board => readCarryingCapacity(ctx.info.root, events(board), { from: weekFrom, to }));
  const weeks = await withBoard(ctx, async board => { recordCapacityWeek(board, capacityWeekRow(weekly, to)); return capacityWeeks(board); });
  io.result?.({ report, weeks });
  const carrying = report.carryingCapacity;
  if (!values.detail) {
    io.say(`carrying capacity ${from} to ${to}: ${carrying.landings} landings, ${carrying.conflicts} conflicts`);
    io.say(`model: k ${carrying.k ?? 'unknown'}; 5% line ${carrying.agentsAtFivePercent ?? 'unknown'} agents; peak ${carrying.peakAgents ?? 'unknown'} agents, ${carrying.peakOutput ?? 'unknown'} output`);
    io.say(`in flight ${carrying.inFlight ?? 'unknown'}: building ${carrying.buildingInFlight ?? 'unknown'}, waiting ${carrying.waitingInFlight ?? 'unknown'}; cells/item ${carrying.cellsPerItem ?? 'unknown'}`);
    io.say(`kernel churn ${carrying.kernelChurnPerWeek ?? 'unknown'} changes/week; wide items ${carrying.wideItemShare ?? 'unknown'}; busiest cell ${carrying.busiestCell ? `${carrying.busiestCell.cell} (${carrying.busiestCell.share})` : 'unknown'}`);
    io.say(`held-out file conflicts: predicted ${carrying.validation.predictedFileConflicts ?? 'unknown'}, actual ${carrying.validation.actualFileConflicts}; relative error ${carrying.validation.relativeError ?? 'unknown'}`);
    io.say(predictionLine(report.predictions));
    io.say(`item build budget: ${report.builds.budgetMinutes} min; ${report.builds.calibration.samples} samples`);
    for (const row of report.builds.items.filter(item => item.expectedMinutes !== null)) io.say(`#${row.item} build: expected ${minutes(row.expectedMinutes)}; actual ${minutes(row.actualMinutes)}; ratio ${row.ratio === null ? 'unknown' : row.ratio.toFixed(3)}`);
    io.say(`test-work: suite ${minutes(report.suite.minutes)}; per landing ${minutes(report.perLanding.minutes)}; ${report.perLanding.missingExecutions} missing executions, ${report.perLanding.unknownReceipts} unknown receipts`);
    io.say(`push gate: ${report.pushGate.shards ?? 'unknown'} shards (${report.pushGate.why})${report.pushGate.timeCoverage ? `; ${fileTimesCoverageNote(report.pushGate.timeCoverage)}` : ''}`);
    io.say(`file classes: ${report.files.pure} pure, ${report.files.contract} contract, ${report.files.unknown} unknown; assumptions and cost details: --detail`);
    return 0;
  }
  io.say(`carrying capacity ${from} to ${to}: ${carrying.landings} landings, ${carrying.conflicts} conflicts; conflicts/landing ${carrying.conflictsPerLanding ?? 'unknown'}`);
  io.say(`collision k ${carrying.k ?? 'unknown'}; 5% line ${carrying.agentsAtFivePercent ?? 'unknown'} agents; model peak ${carrying.peakAgents ?? 'unknown'} agents, ${carrying.peakOutput ?? 'unknown'} output`);
  io.say(`changes in flight ${carrying.inFlight ?? 'unknown'}: building ${carrying.buildingInFlight ?? 'unknown'}, waiting ${carrying.waitingInFlight ?? 'unknown'}; cells/item ${carrying.cellsPerItem ?? 'unknown'}`);
  io.say(`kernel churn ${carrying.kernelChurnPerWeek ?? 'unknown'} changes/week; wide items ${carrying.wideItemShare ?? 'unknown'}; busiest cell ${carrying.busiestCell ? `${carrying.busiestCell.cell} (${carrying.busiestCell.share})` : 'unknown'}`);
  io.say(`held-out file conflicts: predicted ${carrying.validation.predictedFileConflicts ?? 'unknown'}, actual ${carrying.validation.actualFileConflicts}; relative error ${carrying.validation.relativeError ?? 'unknown'}`);
  for (const file of carrying.files.slice(0, 10)) io.say(`${file.file}: shared touches ${file.sharedTouches ?? 'unknown'}, conflict rate ${file.rate ?? 'unknown'}, pressure ${file.pressure ?? 'unknown'}`);
  for (const assumption of carrying.assumptions) io.say(assumption);
  io.say(predictionLine(report.predictions));
  io.say(`item build budget: ${report.builds.budgetMinutes} min; ${report.builds.calibration.samples} expected/actual samples`);
  for (const row of report.builds.items.filter(item => item.expectedMinutes !== null)) io.say(`#${row.item} build: expected ${minutes(row.expectedMinutes)}; actual ${minutes(row.actualMinutes)}; ratio ${row.ratio === null ? 'unknown' : row.ratio.toFixed(3)}`);
  io.say(`suite test-work: ${minutes(report.suite.minutes)} (serial per-file execution work, not parallel elapsed wall time)`);
  if (report.suite.unavailableReason) io.say(report.suite.unavailableReason);
  io.say(`test-work per landing: ${minutes(report.perLanding.minutes)} (${report.perLanding.landings} landing units: explicit batches or unmatched distinct merge commits; batch grouping unknown for the latter; known subtotal ${minutes(report.perLanding.knownMinutes)}; ${report.perLanding.missingExecutions} missing executions; ${report.perLanding.unknownReceipts} unknown-file receipts)`);
  io.say(`declared pure/contract-only share: ${report.files.pure + report.files.contract}/${report.files.total}; ${report.files.unknown} unknown files (lower bound)`);
  io.say(`push gate: ${report.pushGate.shards ?? 'unknown'} shards for ${report.pushGate.fileCount ?? 'unknown'} files, ${report.pushGate.totalMs ?? 'unknown'} ms total, target ${report.pushGate.targetMs} ms, ${report.pushGate.runners ?? 'unknown'} live runners (${report.pushGate.why})`);
  io.say(report.conversion.basis);
  for (const row of report.conversion.order) io.say(`${row.file}: ${row.runtimeMs}ms; ${row.realCatches} recorded catches; ${row.proposal}`);
  return 0;
}
