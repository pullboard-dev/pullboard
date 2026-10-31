/** Maintain an independently versioned report cursor so older writers require only tail catch-up [R1,R2]. */
import { moveFlowItem } from './stats-flow.js';
import {
  FLOW_REPORT_VERSION,
  advanceReport,
  affectedReportItems,
  indexReportItem,
  newReportPolicy,
  prepareReportMove,
  recordReport,
  recordReportPolicy,
  reportEvent,
} from './stats-flow-report.js';

/** An empty report has measured empty history; its cursor is independent of legacy proof writers. */
export function emptyReportCounter() { return { version: FLOW_REPORT_VERSION, last: 0, invalid: false }; }

/** Fold one event using the existing canonical lifecycle, without touching ordinary proof counters. */
export function appendReportCounter(event, detail, at, read, write) {
  const summary = read('report-summary') ?? emptyReportCounter();
  if (event.event_id <= summary.last) return;
  const reporting = reportEvent(event, detail);
  const policy = reporting ? read('report-policy') ?? newReportPolicy() : null;
  const before = reporting ? JSON.stringify(policy) : null;
  const key = `report-item:${event.item_id}`;
  const existing = event.item_id == null ? null : read(key);
  for (const id of reporting ? affectedReportItems(policy, event, detail) : []) {
    const item = read(`report-item:${id}`);
    if (!item) continue;
    advanceReport(item, policy, at);
    write(`report-item:${id}`, item);
  }
  if (reporting) recordReportPolicy(policy, event, detail, existing);
  if (event.item_id != null) {
    // Reload if a policy move just charged this same item's prior interval.
    const item = read(key) ?? { id: event.item_id, lane: 'unknown' };
    if (reporting) {
      advanceReport(item, policy, at);
      prepareReportMove(item, event, detail);
      moveFlowItem(item, event, detail, at);
      recordReport(item, event, detail);
      indexReportItem(policy, item);
    }
    if (reporting || !existing) write(key, item);
  }
  if (reporting && JSON.stringify(policy) !== before) write('report-policy', policy);
  summary.last = event.event_id;
  write('report-summary', summary);
}
