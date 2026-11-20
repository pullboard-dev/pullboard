import { hookStanding } from './src/logic/hook-compat.js';

/**
 * The version a git hook's probe is told for the hook scripts a repo holds: their own when they are one release back, else this release.
 * A pure door of one module, so the probe that runs before every hook loads nothing else [C7].
 *
 * @param {string} release This release.
 * @param {string[]} scripts The text of each installed hook script.
 * @returns {string}
 */
export function hookProbeAnswer(release, scripts) {
  const standing = hookStanding(release, scripts);
  return standing.state === 'accepted' ? standing.versions[0] : release;
}
