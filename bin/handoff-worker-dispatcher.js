#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../packages/gate/index.js';
import { drainHandoffQueue, handoffWorkerCapacity } from '../packages/resources/index.js';
import { loadMachineSettings } from '../packages/config/index.js';
import { effectiveRunners } from '../packages/runners/index.js';

/** Total slots of the registered runners; unreadable settings count as none, leaving the local cap. */
function registeredRunnerSlots() {
  try { return effectiveRunners(loadMachineSettings()).reduce((sum, runner) => sum + runner.slots, 0); }
  catch { return 0; /* no runners readable: the local core cap still applies */ }
}

try { await drainHandoffQueue({ startOf: exactStart, capacity: handoffWorkerCapacity({ runnerSlots: registeredRunnerSlots() }) }); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
