/** The trunk remote board setting: where runners fetch candidates and the lander pushes trunk, apart from the board host [P7]. */

// Budget: a git URL or path, never a document.
const MAX_REMOTE = 2048;

/**
 * The trunk remote a parsed pullboard.json names, or null when it names none. `trunk.remote` is the setting;
 * `landing.trunkRemote` is its old name, still read for one release.
 * Why one reader: runner serve, the pull lander, the land job and landingRemote must all name the same remote.
 *
 * @param {{ trunk?: { remote?: unknown }, landing?: { trunkRemote?: unknown } } | null | undefined} config
 * @returns {string | null}
 */
export function configTrunkRemote(config) {
  const remote = config?.trunk?.remote;
  if (typeof remote === 'string' && remote) return remote;
  const alias = config?.landing?.trunkRemote;
  return typeof alias === 'string' && alias ? alias : null;
}

/**
 * The problems with pullboard.json's `trunk` setting, as configProblems lines. `trunk.remote` is a git URL or path;
 * empty keeps today's sources (the board host's own repository for runners, the trunk branch's remote for the lander).
 * Why no password: the setting is committed and handed to every runner in a claim, so a credential in it would leak.
 * Why the alias must agree: two names for one remote that differ would split where runners fetch and the lander pushes.
 *
 * @param {any} trunk
 * @param {any} [landing] - The landing section, whose old `trunkRemote` name is an alias for one release.
 * @returns {string[]}
 */
export function trunkProblems(trunk, landing) {
  const remote = trunk?.remote;
  if (!trunk || typeof trunk !== 'object' || Array.isArray(trunk) || Object.keys(trunk).some(key => key !== 'remote')
    || typeof remote !== 'string' || remote.length > MAX_REMOTE || /[\s\0]/u.test(remote) || remote.startsWith('-')) {
    return ['"trunk.remote" is one git URL or path with no spaces, like "https://github.com/owner/repo.git", or "" for the board host\'s repository'];
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/iu.test(remote)) return ['"trunk.remote" must not carry a password; give runners their own git credentials instead'];
  const alias = landing?.trunkRemote;
  if (remote && typeof alias === 'string' && alias && alias !== remote) {
    return ['"landing.trunkRemote" is the old name for "trunk.remote" and names a different remote; keep only "trunk.remote"'];
  }
  if (typeof alias === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/iu.test(alias)) return ['"landing.trunkRemote" must not carry a password; give runners their own git credentials instead'];
  return [];
}
