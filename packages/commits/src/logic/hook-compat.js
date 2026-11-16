/**
 * Which hook versions a release still accepts (R4: the current release and the one before it).
 *
 * A hook script carries `want='<version>'` and refuses any binary whose --version differs, and a script already
 * written to disk cannot be changed. So the newer binary answers the hook's version probe with the hooks' own
 * version when they are one release back, and an upgrade never stops a seat's commit (#7760).
 */

/** The release before this one, or null when the number alone cannot say (a minor or major bump). */
export function releaseBefore(version) {
  const parts = String(version).split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN) || parts[2] < 1) return null;
  return `${parts[0]}.${parts[1]}.${parts[2] - 1}`;
}

/** The version a hook script was written by, or null when it has no `want=` line. */
export function hookWants(text) {
  return /^want='([^']*)'/mu.exec(String(text))?.[1] ?? null;
}

/**
 * How a set of installed pullboard hooks stands against this release.
 *
 * @param {string} current This release.
 * @param {string[]} scripts The text of each installed pullboard hook script.
 * @returns {{state: 'none'|'current'|'accepted'|'stale', versions: string[]}} accepted: all one release back, so they still run; stale: anything older or mixed.
 */
export function hookStanding(current, scripts) {
  const versions = [...new Set(scripts.map(hookWants).filter((want) => want !== null))];
  if (!versions.length) return { state: 'none', versions };
  if (versions.length === 1 && versions[0] === current) return { state: 'current', versions };
  if (versions.length === 1 && versions[0] === releaseBefore(current)) return { state: 'accepted', versions };
  return { state: 'stale', versions };
}
