#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../packages/gate/index.js';
import { drainHandoffQueue, handoffWorkerCapacity } from '../packages/resources/index.js';
import { loadMachineSettings } from '../packages/config/index.js';
import { effectiveRunners } from '../packages/runners/index.js';

/** The worker cap from the current machine settings; unreadable settings count as no runners, leaving the local cap. */
function currentCapacity() {
  let settings;
  try { settings = loadMachineSettings(); }
  catch { return handoffWorkerCapacity(); /* no runners readable: the local core cap still applies */ }
  let runnerSlots = 0;
  try { runnerSlots = effectiveRunners(settings).reduce((sum, runner) => sum + runner.slots, 0); }
  catch { runnerSlots = 0; /* no runners readable: the local core cap still applies */ }
  return handoffWorkerCapacity({ runnerSlots, runnersOnly: settings.gate?.runnersOnly === true });
}

// The cap is read on every dispatch pass, so a raised runner fleet or runnersOnly takes effect without a restart.
try { await drainHandoffQueue({ startOf: exactStart, capacity: currentCapacity }); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
