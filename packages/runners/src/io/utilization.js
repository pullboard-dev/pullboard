/** Advisory peak occupancy from retained physical receipts, never guessed idle capacity [C7]. */
import { retainedReceipts } from '../../../gate/index.js';
import { runnerStage } from '../logic/stage.js';
import { readRunnerCapacities } from './capacity.js';

const FIVE_MINUTES = 300_000;
const HOUR = 3_600_000;
const TARGET = 0.7;

/** A receipt may overlap a bucket even when its interval is incomplete; its stage then stays unknown. */
function overlaps(receipt, start, end) {
  const admitted = Date.parse(receipt.admittedAt);
  const finished = Date.parse(receipt.finishedAt);
  const at = Date.parse(receipt.at);
  return Number.isFinite(admitted) && Number.isFinite(finished) && finished > start && admitted < end
    || Number.isFinite(at) && at >= start && at < end;
}

/**
 * Measure the highest fixed five-minute occupied-slot share in an explicit, bounded window. These are this board's
 * retained completed runs, a lower bound on machine demand; missing evidence never establishes that a host is idle.
 */
export function runnerUtilization(runners, receipts, { from, to }) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > HOUR) {
    throw new TypeError('runner utilization needs an increasing window of at most one hour');
  }
  const rows = runners.map(runner => ({ id: runner.id, slots: runner.slots.current, peakBusyShare: null,
    peakWindow: null, measuredWindows: 0, unknownWindows: 0, receiptCount: 0, warning: null, slotsForTarget: null }));
  // Timing occupies every slot only with explicit exclusivity evidence; older assertions stay unmeasured.
  const physical = receipts.filter(receipt => receipt.inherited !== true && receipt.slot?.kind !== 'inherited')
    .map(receipt => receipt.timing === true && (receipt.exclusive !== true || !Array.isArray(receipt.unfencedClients) || receipt.unfencedClients.length)
      ? { ...receipt, exclusive: false } : receipt);
  for (const row of rows) row.receiptCount = physical.filter(receipt => receipt.runner?.id === row.id && overlaps(receipt, start, end)).length;
  for (let bucket = start; bucket < end; bucket += FIVE_MINUTES) {
    const until = Math.min(end, bucket + FIVE_MINUTES);
    const window = { from: new Date(bucket).toISOString(), to: new Date(until).toISOString() };
    const stage = runnerStage(runners, physical, window);
    for (const row of rows) {
      const relevant = physical.some(receipt => receipt.runner?.id === row.id && overlaps(receipt, bucket, until));
      const share = stage.runners.find(runner => runner.id === row.id).busyShare;
      if (!relevant || share === null) { row.unknownWindows += 1; continue; }
      row.measuredWindows += 1;
      if (row.peakBusyShare === null || share > row.peakBusyShare) {
        row.peakBusyShare = share;
        row.peakWindow = window;
      }
    }
  }
  for (const row of rows) {
    if (row.peakBusyShare === null || row.peakBusyShare <= TARGET) continue;
    row.slotsForTarget = Math.ceil(row.slots * row.peakBusyShare / TARGET);
    row.warning = `runner ${row.id}: observed peak utilization ${(row.peakBusyShare * 100).toFixed(1)}% exceeds 70% in ${row.peakWindow.from} to ${row.peakWindow.to}; retained board runs only; at least ${row.slotsForTarget} slots for this observed load at 70% (capacity unchanged)`;
  }
  return { from, to, bucketMs: FIVE_MINUTES, target: TARGET, coverage: 'retained completed board runs; other boards and unfinished runs are unmeasured',
    runners: rows, warnings: rows.flatMap(row => row.warning ? [row.warning] : []) };
}

/** Read existing observations for status without starting probes or changing any runner capacity. */
export function readRunnerUtilization(root, now = Date.now()) {
  const window = { from: new Date(now - HOUR).toISOString(), to: new Date(now).toISOString() };
  try {
    const receipts = retainedReceipts(root, window);
    return { available: true, ...runnerUtilization(readRunnerCapacities(receipts), receipts, window) };
  } catch {
    return { available: false, warnings: [], coverage: 'runner utilization unavailable; inspect pullboard resources' };
  }
}
