/** The trunk remote board setting: where runners fetch candidates and the lander pushes trunk, apart from the board host [P7]. */

// Budget: a git URL or path, never a document.
const MAX_REMOTE = 2048;

/**
 * The problems with pullboard.json's `trunk` setting, as configProblems lines. `trunk.remote` is a git URL or path;
 * empty keeps today's sources (the board host's own repository for runners, the trunk branch's remote for the lander).
 * Why no password: the setting is committed and handed to every runner in a claim, so a credential in it would leak.
 *
 * @param {any} trunk
 * @returns {string[]}
 */
export function trunkProblems(trunk) {
  const remote = trunk?.remote;
  if (!trunk || typeof trunk !== 'object' || Array.isArray(trunk) || Object.keys(trunk).some(key => key !== 'remote')
    || typeof remote !== 'string' || remote.length > MAX_REMOTE || /[\s\0]/u.test(remote) || remote.startsWith('-')) {
    return ['"trunk.remote" is one git URL or path with no spaces, like "https://github.com/owner/repo.git", or "" for the board host\'s repository'];
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/iu.test(remote)) return ['"trunk.remote" must not carry a password; give runners their own git credentials instead'];
  return [];
}
