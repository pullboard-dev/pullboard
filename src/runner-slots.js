/** Runner slot counts computed from each runner's own measured cores and memory (opt-in gate.measuredSlots) [C7]. */

/** One core stays free for the runner's worker and the operating system. */
export const RESERVED_CORES = 1;
/** Memory left to the operating system and the worker before any slot is counted. */
export const RESERVED_MEMORY_MB = 2048;
/** Memory one plain test slot is given. */
export const PLAIN_SLOT_MB = 512;
/** Memory one browser slot is given. */
export const BROWSER_SLOT_MB = 2048;

/**
 * Reserve one core and 2 GB. Total slots fit plain tests; the browser cap reserves the extra
 * 1536 MB for each browser replacing a plain test, so every admitted mixture fits the same budget.
 * A runner below either reserve offers zero computed capacity; explicit fixed overrides remain explicit.
 * @param {{cores:number,memoryMB:number}} measured
 * @returns {{slots:number,browser:number}}
 */
export function computeRunnerSlots({ cores, memoryMB }) {
  if (!Number.isSafeInteger(cores) || cores < 1 || !Number.isSafeInteger(memoryMB) || memoryMB < 1) {
    throw new TypeError('runner cores and memory must be measured positive whole numbers');
  }
  const usableMB = Math.max(0, memoryMB - RESERVED_MEMORY_MB);
  const slots = Math.max(0, Math.min(cores - RESERVED_CORES, Math.floor(usableMB / PLAIN_SLOT_MB)));
  const browser = Math.max(0, Math.min(slots,
    Math.floor((usableMB - slots * PLAIN_SLOT_MB) / (BROWSER_SLOT_MB - PLAIN_SLOT_MB))));
  return { slots, browser };
}

/** True when the runner has a measurement and no declared fixed count. */
export function runnerIsComputed(runner) {
  return runner.fixed !== true && Number.isSafeInteger(runner.cores) && Number.isSafeInteger(runner.memoryMB);
}

/** The slot counts the gate offers for one runner: computed when enabled and measured, else the registered counts. */
export function effectiveRunner(runner, enabled) {
  if (!enabled || !runnerIsComputed(runner)) return runner;
  const computed = computeRunnerSlots(runner);
  // A browserless registration (browser 0) stays browserless; memory only ever lowers browser capacity.
  return { ...runner, slots: computed.slots, browser: runner.browser === 0 ? 0 : computed.browser };
}

/** Apply effectiveRunner to every registered runner under the machine's gate.measuredSlots setting. */
export function effectiveRunners(settings) {
  const enabled = settings.gate?.measuredSlots === true;
  return (settings.runners ?? []).map(runner => effectiveRunner(runner, enabled)).filter(runner => runner.slots > 0);
}

/** Fresh measurements are reused for five minutes; the next actual admission refreshes stale hosts. */
export const RUNNER_MEASUREMENT_MS = 5 * 60_000;

/** Refresh outside resource admission; only an authenticated healthy nonce can replace measured facts. */
export async function refreshRunnerMeasurements(settings, { measure, record, now = Date.now() }) {
  if (settings.gate?.measuredSlots !== true) return;
  if (typeof measure !== 'function' || typeof record !== 'function') throw new TypeError('runner measurement requires canonical transport and persistence');
  await Promise.all((settings.runners ?? []).map(async runner => {
    const at = Date.parse(runner.measuredAt);
    if (Number.isFinite(at) && now >= at && now - at < RUNNER_MEASUREMENT_MS) return;
    try {
      const observed = await measure(runner, { observeGui: true });
      if (!observed.healthy || !Number.isSafeInteger(observed.cores) || observed.cores < 1
          || !Number.isSafeInteger(observed.memoryMB) || observed.memoryMB < 1) return;
      record(runner.host, { cores: observed.cores, memoryMB: observed.memoryMB,
        measuredAt: new Date(now).toISOString(), gui: observed.gui });
    } catch { /* Failed or busy observations preserve prior facts and every transport recovery obligation. */ }
  }));
}
