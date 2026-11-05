/** Keep each view-served board's health observer running without overlapping scans [A6]. */
import { spawn } from './windows-child-process.js';
import { fileURLToPath } from 'node:url';
import { listProjects } from './projects.js';
import { loadConfig } from './config.js';
import { healthSentinelEnabled } from './settings.js';
import { startRelayCanaryWatch } from './relay-canary-watch.js';

/** Ten minutes is the declared background cadence, not a test performance budget. */
export const HEALTH_SENTINEL_INTERVAL_MS = 10 * 60_000;
const CLI = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));

/** Read the board and machine off switches before starting any background child. */
function sentinelRunsFor(root) {
  return healthSentinelEnabled(loadConfig(root));
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

/** Start after the view listens; scans use the ordinary sentinel command so each board's off switch and ordering apply. */
export function startServeSentinel({ projectRoot, run = refreshBoard, projects = listProjects,
  every = setInterval, cancel = clearInterval, enabled = sentinelRunsFor, onError = () => {}, runCanary = refreshCanary, canary = startRelayCanaryWatch } = {}) {
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
  const timer = every(tick, HEALTH_SENTINEL_INTERVAL_MS);
  timer.unref?.();
  return {
    /** Stop the interval and wait for the exact active child to finish shutting down. */
    async close() {
      cancel(timer); lifetime.abort();
      await Promise.all([pending, canaryWatch.close()]);
    },
  };
}
