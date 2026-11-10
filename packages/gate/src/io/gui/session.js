/** Read this execution user's Darwin GUI-domain availability without environment guesses. */
import {
  spawnSync,
} from 'node:child_process';

/**
 * Return a fresh GUI-domain observation: true, known absent false, or unknown null.
 * Injected dependencies are for isolated unit fixtures, not capability attestations.
 *
 * @param {object} [options]
 * @param {typeof spawnSync} [options.run] - bounded native-command runner
 * @param {string} [options.platform] - fixture platform; production uses this process
 * @param {() => number} [options.getuid] - fixture UID reader; production uses this process
 * @returns {boolean | null}
 */
export function guiSession({ run = spawnSync, platform = process.platform, getuid = process.getuid } = {}) {
  if (platform !== 'darwin' || typeof getuid !== 'function') return null;
  let uid;
  try { uid = getuid(); }
  catch { return null; } // Unavailable identity cannot establish this execution user's domain.
  if (!Number.isInteger(uid) || uid < 0 || uid >= 0xffffffff) return null;
  let result;
  try {
    result = run('/bin/launchctl', ['print', `gui/${uid}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 1_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4_096,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
  } catch { return null; } // Spawn, timeout and read failures provide no negative capability fact.
  if (!result || result.error || result.signal || !Number.isInteger(result.status)) return null;
  if (result.status === 0) return true;
  const missing = /(?:^|\r?\n)Could not find domain for(?:[^\r\n]*)?(?:\r?\n|$)/u;
  if (typeof result.stderr === 'string' && missing.test(result.stderr)) return false;
  return null;
}
