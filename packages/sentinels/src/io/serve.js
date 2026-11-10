/** Keep each view-served board's health observer running without overlapping scans [A6]. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listProjects } from "../../../seats/index.js";
import { loadConfig } from "../../../config/index.js";
import { healthSentinelEnabled } from "../../../config/index.js";
import { startRelayCanaryWatch } from "../../../link/index.js";

/** Ten minutes is the declared background cadence, not a test performance budget. */
export const HEALTH_SENTINEL_INTERVAL_MS = 10 * 60_000;
/** A dead landing worker is replaced within two minutes, so its cheap pid check runs every minute (#2912). */
export const LANDING_LIVENESS_INTERVAL_MS = 60_000;
/** The wait audit runs every minute, so no hold, wait or process sits over its budget unseen for longer (C7). */
const WAITS_AUDIT_INTERVAL_MS = 60_000;
const CLI = fileURLToPath(new URL('../../../../apps/cli/pullboard.js', import.meta.url));

/** Read the board and machine off switches before starting any background child. */
function sentinelRunsFor(root) {
  const config = loadConfig(root);
  return config.claims.releaseGone || healthSentinelEnabled(config);
}

/** Run only the ordered health scan in one owned child and drain it on view shutdown. */
function refreshBoard(root, signal, words = ['sentinel', 'run', '--health-only', '--json'], degradedIsExpected = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...words], {
      cwd: root, env: process.env, stdio: 'ignore', signal,
    });
    let timer;
    /** Bound shutdown of this exact child; never signal a peer or a process selected by name. */
    const stopping = () => {
      timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5_000); // budget: owned-child shutdown ceiling after AbortSignal sends SIGTERM.
      timer.unref();
    };
    signal.addEventListener('abort', stopping, { once: true });
    child.once('error', error => { if (error.name !== 'AbortError') reject(error); });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', stopping);
      if (code && !(degradedIsExpected && code === 1) && !signal.aborted) reject(new Error(`health sentinel refresh exited ${code}`));
      else resolve();
    });
  });
}

/** Run the configured ordinary canary command; a failed round trip is a recorded observation. */
function refreshCanary(root, signal) {
  return refreshBoard(root, signal, ['relay', 'canary', 'run', '--json'], true);
}

/** Start after the view listens; `recover` replaces a landing worker whose pid died mid-batch (#2912, passed in by the view so this cell imports no landing code); scans use the ordinary sentinel command so each board's off switch and ordering apply. */
export function startServeSentinel({ projectRoot, run = refreshBoard, projects = listProjects,
  every = setInterval, cancel = clearInterval, enabled = sentinelRunsFor, onError = () => {}, runCanary = refreshCanary, canary = startRelayCanaryWatch, recover = async () => false, liveEvery = setInterval, liveCancel = clearInterval,
  audit = (root, signal) => run(root, signal, ['waits', 'record', '--json'], true) } = {}) {
  const canaryWatch = canary({ run: (config, { io }) => runCanary(config.root, io.relaySignal), onError });
  const lifetime = new AbortController();
  let pending = null;
  /** Never start a second scan while the prior one or shutdown is still in flight. */
  const tick = () => {
    if (pending || lifetime.signal.aborted) return pending;
    pending = Promise.resolve().then(async () => {
      const roots = projectRoot ? [projectRoot] : projects().map(project => project.root);
      for (const root of new Set(roots)) {
        if (lifetime.signal.aborted) break;
        try { if (enabled(root)) await run(root, lifetime.signal); }
        catch (error) { if (!lifetime.signal.aborted) onError(error); }
      }
    }).catch(onError).finally(() => { pending = null; });
    return pending;
  };
  let recovering = null;
  /** One landing liveness pass at a time; a failure is reported and the next minute tries again. */
  const livenessTick = () => {
    if (recovering || lifetime.signal.aborted) return recovering;
    recovering = Promise.resolve().then(async () => {
      const roots = projectRoot ? [projectRoot] : projects().map(project => project.root);
      for (const root of new Set(roots)) {
        if (lifetime.signal.aborted) break;
        try { if (enabled(root)) await recover(root); }
        catch (error) { if (!lifetime.signal.aborted) onError(error); }
      }
    }).catch(onError).finally(() => { recovering = null; });
    return recovering;
  };
  const liveness = liveEvery(livenessTick, LANDING_LIVENESS_INTERVAL_MS);
  liveness.unref?.();
  let auditing = null;
  /** One wait audit at a time, in its own child; a slow runner ssh never delays landing liveness. */
  const auditTick = () => {
    if (auditing || lifetime.signal.aborted) return auditing;
    auditing = Promise.resolve().then(async () => {
      const roots = projectRoot ? [projectRoot] : projects().map(project => project.root);
      for (const root of new Set(roots)) {
        if (lifetime.signal.aborted) break;
        try { if (enabled(root)) await audit(root, lifetime.signal); }
        catch (error) { if (!lifetime.signal.aborted) onError(error); }
      }
    }).catch(onError).finally(() => { auditing = null; });
    return auditing;
  };
  const waits = liveEvery(auditTick, WAITS_AUDIT_INTERVAL_MS);
  waits.unref?.();
  const timer = every(tick, HEALTH_SENTINEL_INTERVAL_MS);
  timer.unref?.();
  return {
    /** Stop the interval and wait for the exact active child to finish shutting down. */
    async close() {
      cancel(timer); liveCancel(liveness); liveCancel(waits); lifetime.abort();
      await Promise.all([pending, recovering, auditing, canaryWatch.close()]);
    },
  };
}
