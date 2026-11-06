#!/usr/bin/env node
/** Keep machine handoff admission separate from the gate's exact process-identity provider [C7]. */
import { exactStart } from '../packages/gate/index.js';
import { drainHandoffQueue, handoffWorkerCapacity } from '../packages/resources/index.js';
import { loadMachineSettings } from '../packages/config/index.js';
import { effectiveRunners } from '../packages/runners/index.js';
import { dispatchRunnerTicket } from '../apps/cli/src/shell/submit-runner-dispatch.js';
import { fileURLToPath } from 'node:url';

/** The worker cap from the current machine settings; unreadable settings count as no runners, leaving the local cap. */
export function currentCapacity(env = {}) {
  // The dispatcher is launched by whichever seat submits first and would inherit that seat's environment: on 6 Nov a
  // seat script exporting PULLBOARD_HANDOFF_WORKERS=6 capped the whole machine at 6 workers for six hours while 54
  // gates queued and 41 runner slots sat free. The machine's cap comes from its settings; an override is passed in
  // explicitly, never read from the inherited environment [C7].
  let settings;
  try { settings = loadMachineSettings(); }
  catch { return handoffWorkerCapacity({ env }); /* no runners readable: the local core cap still applies */ }
  let runnerSlots = 0;
  try { runnerSlots = effectiveRunners(settings).reduce((sum, runner) => sum + runner.slots, 0); }
  catch { runnerSlots = 0; /* no runners readable: the local core cap still applies */ }
  return handoffWorkerCapacity({ env, runnerSlots, runnersOnly: settings.gate?.runnersOnly === true });
}

// The cap is read on every dispatch pass, so a raised runner fleet or runnersOnly takes effect without a restart.
// Only a direct launch drains; importing this file to read its cap (as the test does) starts nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await drainHandoffQueue({ startOf: exactStart, capacity: currentCapacity, runnerTicket: dispatchRunnerTicket }); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
