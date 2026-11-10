/** Read a privacy-safe runner capacity snapshot for one explicit stats window [C7,O5]. */
import { guiSession } from '../../../../packages/gate/index.js';
import { retainedReceipts } from '../../../../packages/gate/index.js';
import { localRunnerDescriptor } from '../../../../packages/runners/index.js';
import {
  listResources,
  runnerResourceStatus,
} from '../../../../packages/resources/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { runnerStage } from '../logic/stage.js';

const PLATFORMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32']);

/** Return a platform only when an actual structured executor receipt reports a recognized OS. */
function reportedPlatform(receipts, id) {
  return receipts.filter(receipt => receipt.runner?.id === id)
    .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))
    .map(receipt => receipt.runner?.capabilities?.os)
    .find(platform => typeof platform === 'string' && PLATFORMS.has(platform)) ?? null;
}

/** Build current descriptors from validated settings and the live admission databases. */
function currentRunners(settings, receipts, machineResources) {
  const gate = machineResources.find(resource => resource.name === 'gate');
  const browserPool = machineResources.find(resource => resource.name === 'browser');
  const localCapacity = gate?.capacity ?? settings.gateSlots;
  const browserCapacity = browserPool?.capacity ?? settings.browserSlots;
  const local = localRunnerDescriptor(localCapacity, browserCapacity > 0, guiSession());
  const gateHolders = gate?.holders ?? [];
  local.active = gateHolders.some(holder => holder.timing) ? localCapacity
    : gateHolders.filter(holder => holder.slot !== 'short').length;
  local.browserSlots = browserCapacity;
  local.browserActive = gateHolders.filter(holder => holder.browser).length;
  const remotes = runnerResourceStatus(settings.runners ?? []).map(runner => ({
    id: runner.host,
    kind: runner.kind ?? 'ssh',
    slots: { current: runner.slots, limit: runner.slots, elastic: false },
    capabilities: { os: reportedPlatform(receipts, runner.host), browser: runner.browser > 0, gui: runner.gui ?? null },
    active: runner.holders.some(holder => holder.timing === 1) ? runner.slots : runner.inUse,
    browserSlots: runner.browser,
    browserActive: runner.browserInUse,
    ...(runner.unavailable ? { unavailable: true } : {}),
    ...(runner.draining ? { draining: true } : {}),
  }));
  return [local, ...remotes];
}

/** Read retained physical-run receipts and live capacity for exactly `[from,to)`. */
export function readRunnerStage(root, { from, to }) {
  const settings = loadMachineSettings();
  // Bracket the receipt read with physical-holder snapshots. Changed snapshots are unmeasured,
  // avoiding a finished receipt plus a stale open observation counting the same work twice.
  const before = listResources({ scope: 'machine' }).find(resource => resource.name === 'gate')?.holders ?? [];
  const receipts = retainedReceipts(root, { from, to });
  const resources = listResources({ scope: 'machine' });
  const holders = resources.find(resource => resource.name === 'gate')?.holders ?? [];
  const observedUntil = new Date().toISOString();
  const runners = currentRunners(settings, receipts, resources);
  const local = runners[0];
  const live = [];
  if (JSON.stringify(before) !== JSON.stringify(holders)) {
    live.push({ ongoing: true, observedUntil, admittedAt: null, runner: local });
  } else {
    for (const holder of holders) live.push({ ongoing: true, admittedAt: holder.since, observedUntil,
      runner: local, timing: holder.timing === true,
      // A timing bit does not attest the absence of unfenced legacy clients.
      ...(holder.timing ? { exclusive: null } : {}) });
  }
  for (const runner of runners.slice(1)) {
    // These are controller reservations, not the worker's physical admission timestamps.
    if (runner.active > 0) live.push({ ongoing: true, admittedAt: null, observedUntil, runner });
  }
  return runnerStage(runners, [...receipts, ...live], { from, to });
}
