import { tryGit } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { trunkRemote } from '../../../../../packages/config/index.js';
import { pullGit } from '../runner/git.js';
import { receiveCommits } from '../../../../../packages/pin/index.js';
import { placeRemoteItem } from '../../../../../packages/pin/index.js';

/** True when a move's commits name a head and a ref the clone already pushed, instead of carrying a bundle [P7]. */
export function carriesPushedRef(commits) {
  return commits !== null && typeof commits === 'object' && 'ref' in commits;
}

/**
 * Gate a commit a remote seat already pushed to trunk.remote: fetch the named ref from the trunk remote, check that
 * the declared head is on it, and return the host folder whose detached head is that commit, for the submit to run in.
 * Why: a seat that pushed its work needs no bundle, and the board must judge the pushed commit, not its own checkout HEAD.
 *
 * @param {string} root - The board host's checkout.
 * @param {{ verb: string, item?: number, agent?: string, commits: { head: string, ref: string } }} body
 * @param {{ remoteAgent?: string }} seat - The resolved seat; only a URL-joined seat sends commits.
 * @param {(read: (board: any) => any) => any} readBoard - Opens the host's board for one read.
 * @param {(board: any, id: number) => any} getItem - The store's item reader.
 * @param {{ remote?: string | null }} [options] - remote: the trunk remote of record; read from the board's configuration when omitted.
 * @returns {Promise<string>} The host folder at the pushed commit.
 */
export async function receivePushed(root, body, seat, readBoard, getItem, { remote = trunkRemote(root) } = {}) {
  const { verb, item, agent, commits } = body;
  if (!['submit', 'done'].includes(verb) || !seat.remoteAgent) throw new Refused('BAD_REQUEST', 'only a submit from a seat joined by board.url carries commits; remove commits from this move');
  if (Object.keys(commits).some((key) => !['head', 'ref'].includes(key)) || !/^[0-9a-f]{40}$/u.test(commits.head ?? '')
    || typeof commits.ref !== 'string' || !/^refs\/[A-Za-z0-9._/-]+$/u.test(commits.ref) || commits.ref.includes('..')) {
    throw new Refused('BAD_REQUEST', 'a pushed submit takes only head (a full commit id) and ref (a full ref name like refs/heads/work); submit again from the clone');
  }
  if (!remote) throw new Refused('NO_TRUNK_REMOTE', 'this board has no trunk.remote to check a pushed commit against; set trunk.remote, or send the commits with board.commits bundle');
  readBoard((board) => {
    const held = getItem(board, item);
    if (held?.item_status !== 'claimed' || held.item_owner !== agent) throw new Refused('NOT_YOURS', `item #${item} is not claimed by ${agent}; claim it before sending its commits`);
  });
  const { head, ref } = commits;
  const listed = tryGit(root, ['ls-remote', remote, ref]);
  const tip = listed.status === 0 ? listed.stdout.split(/\s/u)[0] : '';
  if (!/^[0-9a-f]{40}$/u.test(tip)) {
    throw new Refused('REMOTE_COMMIT_MISSING', `${head.slice(0, 12)} is not on ${ref} at the trunk remote; push it (git push <remote> HEAD:${ref}) and submit again`);
  }
  if ((await pullGit.fetchTrunk(root, remote, [ref])).status !== 0) {
    throw new Refused('REMOTE_COMMIT_MISSING', `the board host could not fetch ${ref} from the trunk remote; push the commit and submit again`);
  }
  const reachable = tip === head || (tryGit(root, ['cat-file', '-e', `${head}^{commit}`]).status === 0
    && tryGit(root, ['merge-base', '--is-ancestor', head, tip]).status === 0);
  if (!reachable) {
    throw new Refused('REMOTE_REF_MISMATCH', `${ref} at the trunk remote is at ${tip.slice(0, 12)}, which does not contain ${head.slice(0, 12)}; push ${head.slice(0, 12)} to ${ref} and submit again`);
  }
  if (tryGit(root, ['update-ref', `refs/pullboard/remote/${agent}/item-${item}`, head]).status !== 0) throw new Refused('COMMITS_REFUSED', `the board host could not record ${head.slice(0, 12)}; submit again from the clone`);
  return placeRemoteItem(root, { agent, item, head });
}

/** The commit receiver a board host serves: a pushed head and ref are checked at trunk.remote, anything else is the bundle path. */
export function receiveMoveCommits(root, body, seat, readBoard, getItem) {
  return carriesPushedRef(body.commits) ? receivePushed(root, body, seat, readBoard, getItem) : receiveCommits(root, body, seat, readBoard, getItem);
}
