/**
 * The board resident's probe of quarantined runners: on its tick it asks the resources cell to probe any runner whose
 * probe is due, so a quarantine clears with no gate waiting [C7,#8325].
 * Why here: the resident is the one long-lived process per board, and #8306's recoverIdleRunners had no caller; landing
 * is the cell above both resources and runners that the CLI may import.
 */

/** The shortest time between two passes; the queue's own probe_after still decides which runner is due. */
export const IDLE_PROBE_INTERVAL_MS = 15_000;

/**
 * The ports a pass needs, built from the runner services the CLI passes in; resources loads on first use so the resident
 * starts without it.
 * Why a parameter: landing may not import the runners front door itself, which reaches the CLI entry [C7].
 */
async function loadPorts(services) {
  const { recoverIdleRunners } = await import('../../../resources/index.js');
  const { effectiveRunners, probeRunnerHealth, probeRunnerTransport } = services.runners;
  return {
    recoverIdleRunners,
    runners: settings => effectiveRunners(settings),
    probes: {
      probe: probeRunnerHealth,
      transportProbe: probeRunnerTransport,
      idleProbe: (runner, previous, { liveJobs = [] } = {}) => probeRunnerHealth(runner, previous, { idle: true, liveJobs }),
      restartProbe: runner => probeRunnerHealth(runner, undefined, { restart: true }),
      leakProbe: (runner, { liveJobs = [] } = {}) => probeRunnerHealth(runner, undefined, { stopLeaked: true, liveJobs }),
    },
  };
}

/**
 * A tick function for the resident: each call starts at most one background pass and returns at once, so a slow probe
 * never delays the tick; a call while a pass runs, or inside the interval, does nothing. The first pass waits one
 * interval, so a resident that serves a command and retires never loads the probes.
 *
 * @param {{ settings: () => object, executionServices: { runners: object }, clock?: () => number, intervalMs?: number, load?: Function }} options `settings` reads the machine settings fresh each pass
 * @returns {() => Promise<void> | null} the running pass's promise, or null when this call started none
 */
export function idleRunnerTick({ settings, executionServices, clock = Date.now, intervalMs = IDLE_PROBE_INTERVAL_MS, load = loadPorts }) {
  let last = clock();
  let pass = null;
  return () => {
    const now = clock();
    if (pass || now - last < intervalMs) return null;
    last = now;
    pass = (async () => {
      const ports = await load(executionServices);
      const runners = ports.runners(settings());
      if (runners.length) await ports.recoverIdleRunners(runners, { ...ports.probes, now: Date.now() });
    })().catch(() => { /* A failed pass leaves the quarantine as it was; the next interval tries again. */ }).finally(() => { pass = null; });
    return pass;
  };
}
