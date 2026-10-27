/** Bind capacity arithmetic to real native events, measured sidecars and committed declarations [C7]. */
import { testClosures } from './affected-tests.js';
import { events } from './board.js';
import { boardReceiptStore, receiptFields } from './gate-run-receipt.js';
import { gateRuns } from './quarantine.js';
import { readTestValueTimings } from './test-value-timing.js';
import { testValueReport } from './test-value.js';
import { capacitySummary, declaredTestBoundary } from './capacity-summary.js';
import { testConversionPlan } from './test-conversion.js';

/** Read one complete native collection in native event order, retaining a red complete audit as red. */
export function testCapacityReport(board, { root, costs, now = Date.now() }) {
  const value = testValueReport(board, { root, costs, now });
  const history = events(board);
  const graph = testClosures(root);
  const inventory = [...graph.closures.keys()].map(file => ({ file,
    kind: declaredTestBoundary(graph.modules.get(file) ?? '') }));
  const latestAudit = gateRuns(board).filter(run => run.by === 'coordinator' && run.kind === 'land'
    && receiptFields(run)?.collection?.full && run.collection.complete && Date.parse(run.at) <= now).at(-1) ?? null;
  const timings = latestAudit ? readTestValueTimings(boardReceiptStore(board), latestAudit.id) : null;
  return { ...capacitySummary({ value, history, latestAudit, timings, inventory }),
    conversion: testConversionPlan(value), inventory };
}
