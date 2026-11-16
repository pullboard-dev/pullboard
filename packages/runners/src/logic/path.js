/** Where a runner's job environment finds git and the other system tools, whatever PATH its service was started with [C7,#8245]. */

/** The system directories every job's PATH ends with: git, ps and lsof live here on Linux and macOS. */
export const SYSTEM_PATH = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

/**
 * A job's PATH: the one given, then each system directory it lacks.
 * Why: a runner service started with a narrow PATH (no /usr/bin) made a job's tests fail spawnSync git ENOENT, a red with no code cause (#8245).
 *
 * @param {string | undefined} path - The PATH the runner service holds, possibly empty or unset.
 * @param {string} [separator] - The PATH separator of this platform.
 * @returns {string} The PATH to give a job; entries keep their order and none repeats.
 */
export function jobPath(path, separator = ':') {
  const kept = String(path ?? '').split(separator).filter(Boolean);
  return [...kept, ...SYSTEM_PATH.filter(directory => !kept.includes(directory))].join(separator);
}
