/** A machine-configured one-minute watch, independent of ordinary ten-minute health scans [H5,H17]. */
import { probeRelayCanary } from './probe.js';
import { claimRelayCanaryTick } from './health.js';
import { observeRelayHealth } from './health.js';
import { readRelayHealth } from './health.js';
import { pendingRelayCanaryNotices } from './health.js';
import { markCanaryNoticeRecorded } from './health.js';
import { pushCanaryAlert } from '../canary-push-wire.js';
import { Refused } from '../../../../../kernel/light.js';
import { relayCanaryConfig } from '../../../../../config/index.js';
import { loadMachineSettings } from '../../../../../config/index.js';

export const RELAY_CANARY_INTERVAL_MS = 60000;

/** Observe exactly one complete probe; optional notices use the ordinary command's board authority. */
export async function runRelayCanary(value, { io = {}, now = Date.now, notify, directPush, probe = probeRelayCanary } = {}) {
  const config = relayCanaryConfig(value);
  if (!config) throw new Refused('RELAY_CANARY_CONFIG', 'configure this machine with pullboard relay canary on before running its watch');
  const observation = await probe(config.root, { agentId: config.agentId,
    deadlineMs: config.deadlineMs, io });
  const update = observeRelayHealth(config.root, observation, { now: now() });
  if (notify) for (const notice of pendingRelayCanaryNotices(config.root)) {
    // A failing relay or push endpoint must never keep the other path from reporting the alert.
    if (directPush) await pushCanaryAlert(directPush, notice).catch(() => null);
    await notify(notice, observation);
    markCanaryNoticeRecorded(config.root, notice.id);
  }
  return { observation, ...update, health: readRelayHealth(config.root, { now: now() }) };
}

/** Start one due local tick; shutdown aborts and awaits the active probe instead of abandoning a write. */
export function startRelayCanaryWatch({ config = () => loadMachineSettings().relay?.canary,
  run = runRelayCanary, now = Date.now, every = setInterval, cancel = clearInterval, onError = () => {}, notify, directPush, keepAlive = false } = {}) {
  const lifetime = new AbortController();
  let pending = null;
  /** Read current machine opt-in on every tick and admit at most one local run for its minute. */
  const tick = () => {
    if (pending || lifetime.signal.aborted) return pending;
    pending = Promise.resolve().then(async () => {
      const selected = relayCanaryConfig(config());
      if (!selected?.enabled || !claimRelayCanaryTick(selected.root, now())) return;
      await run(selected, { io: { relaySignal: lifetime.signal }, now, notify, directPush });
    }).catch(error => { if (!lifetime.signal.aborted) onError(error); }).finally(() => { pending = null; });
    return pending;
  };
  const timer = every(tick, RELAY_CANARY_INTERVAL_MS);
  if (!keepAlive) timer.unref?.();
  void tick();
  return { tick,
    /** Stop scheduling first, then drain the exact in-flight probe under its shared deadline. */
    async close() {
      cancel(timer); lifetime.abort();
      if (pending) await pending;
    },
  };
}

/** Whether relay.excludeByBoard is on (#9414): kept here because this file already reads the machine settings, so link adds no new cell import. */
export function relayExcludeByBoard() {
  return loadMachineSettings().relay?.excludeByBoard === true;
}
