/** Full inventory construction belongs to audit work, never per-change startup [C7]. */
import { testClosures } from './affected-tests.js';
import { testValueReport } from './test-value.js';
import { placementReport } from './test-economics.js';
import { writePlacementIndex } from './test-economics-index.js';

/** Build and publish every placement during audit work using one existing fourteen-day report. */
export function refreshTestPlacement(board, { root, head, config, now = Date.now() }) {
  const measured = testValueReport(board, { root, costs: config.testEconomics, now });
  const { closures, modules } = testClosures(root, head);
  const observations = Object.fromEntries(measured.files.map(row => [row.file, row]));
  const costs = config.testEconomics;
  const report = placementReport({ closures, modules, observations, head, at: new Date(now).toISOString(),
    costs: { escape: costs.costOfEscape, waitPerSecond: costs.costOfWaiting, falseRed: costs.costOfFalseRed,
      landingEscape: costs.costOfEscape, landingWaitPerSecond: costs.costOfWaiting / 10 } });
  report.observationWindow = { since: measured.since, asOf: measured.asOf };
  report.measurementCoverage = measured.coverage;
  writePlacementIndex(root, report);
  return report;
}

