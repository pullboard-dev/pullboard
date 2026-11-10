/** Bind capacity arithmetic to real native events, measured sidecars and committed declarations [C7]. */
import { testClosures } from '../affected/tests.js';
import { events } from '../../../../store/index.js';
import { boardReceiptStore } from '../run/receipt.js';
import { receiptFields } from '../run/receipt.js';
import { readTestValueTimings } from './value/timing.js';
import { testValueReport } from './value.js';
import { capacitySummary } from '../../logic/summary.js';
import { declaredTestBoundary } from '../../logic/summary.js';
import { testConversionPlan } from '../../logic/test/conversion.js';

/** Read one complete native collection in native event order, retaining a red complete audit as red. */
export function testCapacityReport(board, { root, costs, now = Date.now() }, services) {
  if (typeof services?.gateRuns !== 'function') throw new TypeError('test capacity needs an explicit native gate-run reader');
  const { gateRuns } = services;
  const value = testValueReport(board, { root, costs, now }, services);
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
