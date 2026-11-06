#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../packages/gate/index.js';
import { drainHandoffQueue, handoffWorkerCapacityDetail, recordHandoffCap } from '../packages/resources/index.js';
import { loadMachineSettings } from '../packages/config/index.js';
import { effectiveRunners } from '../packages/runners/index.js';
import { fileURLToPath } from 'node:url';

/** The worker cap and its origin from the current machine settings; unreadable settings count as no runners, leaving the local cap. */
export function currentCapacityDetail(env = {}) {
  // The dispatcher is launched by whichever seat submits first and would inherit that seat's environment: on 6 Nov a
  // seat script exporting PULLBOARD_HANDOFF_WORKERS=6 capped the whole machine at 6 workers for six hours while 54
  // gates queued and 41 runner slots sat free. The machine's cap comes from its settings; an override is passed in
  // explicitly, never read from the inherited environment [C7].
  let settings;
  try { settings = loadMachineSettings(); }
  catch { return handoffWorkerCapacityDetail({ env }); /* no runners readable: the local core cap still applies */ }
  let runnerSlots = 0;
  try { runnerSlots = effectiveRunners(settings).reduce((sum, runner) => sum + runner.slots, 0); }
  catch { runnerSlots = 0; /* no runners readable: the local core cap still applies */ }
  return handoffWorkerCapacityDetail({ env, runnerSlots, runnersOnly: settings.gate?.runnersOnly === true });
}

/** The worker cap number from the current machine settings. */
export function currentCapacity(env = {}) { return currentCapacityDetail(env).cap; }

/** The live cap number, recording it and its origin for pullboard status. */
export function liveCapacity(env = {}) {
  const detail = currentCapacityDetail(env);
  recordHandoffCap(detail);
  return detail.cap;
}

// The cap is read on every dispatch pass, so a raised runner fleet or runnersOnly takes effect without a restart.
// Only a direct launch drains; importing this file to read its cap (as the test does) starts nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await drainHandoffQueue({ startOf: exactStart, capacity: liveCapacity }); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
