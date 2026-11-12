/** The hand-off dispatcher's worker cap from the machine settings and the runner fleet [C7]. */
import { loadMachineSettings } from '../../../../config/index.js';
import { handoffWorkerCapacityDetail } from '../../../../resources/index.js';
import { recordHandoffCap } from '../../../../resources/index.js';
import { effectiveRunners } from '../slots.js';

/** The worker cap and its origin from the current machine settings; unreadable settings count as no runners, leaving the local cap. */
export function currentCapacityDetail(env = {}) {
  // The dispatcher is launched by whichever seat submits first and would inherit that seat's environment: on 6 Nov a
  // seat script exporting PULLBOARD_HANDOFF_WORKERS=6 capped the whole machine at 6 workers for six hours while 54
  // gates queued and 41 runner slots sat free. The machine's cap comes from its settings; an override is passed in
  // explicitly, never read from the inherited environment [C7].
  let settings;
  try { settings = loadMachineSettings(); }
  catch { return handoffWorkerCapacityDetail({ env }); /* no runners readable: the local core cap still applies */ }
  // The machine setting gate.handoffWorkers is the one durable way to lower the cap; it reads from the machine's own settings file, so every launch sees the same number [C7].
  const machineCap = settings.gate?.handoffWorkers; // Applied inside handoffWorkerCapacityDetail, the one place the cap is decided [C7].
  let runnerSlots = 0;
  try { runnerSlots = effectiveRunners(settings).reduce((sum, runner) => sum + runner.slots, 0); }
  catch { runnerSlots = 0; /* no runners readable: the local core cap still applies */ }
  return handoffWorkerCapacityDetail({ env, runnerSlots, runnersOnly: settings.gate?.runnersOnly === true, machineCap });
}

/** The worker cap number from the current machine settings. */
export function currentCapacity(env = {}) { return currentCapacityDetail(env).cap; }

/** The live cap number, recording it and its origin for pullboard status. */
export function liveCapacity(env = {}) {
  const detail = currentCapacityDetail(env);
  recordHandoffCap(detail);
  return detail.cap;
}
