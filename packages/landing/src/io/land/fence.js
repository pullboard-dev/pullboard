/** The land push through a git ref fenced by the gate hop's epoch, so a land job whose hop was retaken cannot move trunk [C7,#8275]. */
import { tryGit } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

// A fixed identity and date make one item and epoch hash to the same fence commit on every clone.
const FENCE_IDENTITY = { GIT_AUTHOR_NAME: 'pullboard', GIT_AUTHOR_EMAIL: 'hop@pullboard.invalid', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'pullboard', GIT_COMMITTER_EMAIL: 'hop@pullboard.invalid', GIT_COMMITTER_DATE: '@0 +0000' };

/** The fence ref for an item's hop: it names the commit of the epoch that owns the hop now. */
export function hopFenceRef(item) {
  return `refs/pullboard/hop/${item}`;
}

/**
 * Write the empty commit that stands for one hop epoch and answer its id.
 * Why a commit with a fixed identity: a ref holds an object id, not a number, and the same item and epoch must name the same object on any clone.
 *
 * @param {string} root
 * @param {{ item: number, epoch: number }} hop
 */
export function hopFenceObject(root, { item, epoch }) {
  if (!Number.isSafeInteger(item) || item < 1 || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Refused('HOP_FENCE_EPOCH', 'a hop fence names its item and epoch as whole numbers', 'pass the item and the epoch the hop row gave');
  }
  const tree = tryGit(root, ['hash-object', '-w', '-t', 'tree', '/dev/null']);
  const commit = tree.status === 0 ? tryGit(root, ['commit-tree', tree.stdout, '-m', `pullboard hop ${item} epoch ${epoch}`], { env: { ...process.env, ...FENCE_IDENTITY } }) : tree;
  if (commit.status !== 0) throw new Refused('HOP_FENCE_WRITE', `could not write the fence for #${item} epoch ${epoch}: ${commit.stderr.split('\n')[0]}`, 'check the repository can be written');
  return commit.stdout;
}

/**
 * Point the remote's fence ref at this epoch, only from the epoch before it, so a new hop owner shuts out the one it replaced.
 * The hop row's compare-and-set already gave this owner the epoch; the fence carries it to the remote trunk lives on. Fencing the epoch the ref already holds is a no-op.
 *
 * @param {string} root
 * @param {{ remote: string, item: number, epoch: number }} options
 */
export function fenceHop(root, { remote, item, epoch }) {
  const ref = hopFenceRef(item);
  const next = hopFenceObject(root, { item, epoch });
  const lease = epoch === 1 ? `--force-with-lease=${ref}:` : `--force-with-lease=${ref}:${hopFenceObject(root, { item, epoch: epoch - 1 })}`;
  // No '+' on the refspec: a forced refspec skips the lease, and the lease is the fence.
  const pushed = tryGit(root, ['push', '--atomic', '--quiet', lease, remote, `${next}:${ref}`]);
  if (pushed.status !== 0) throw fenced(root, { remote, item, epoch }, pushed);
  return next;
}

/** The refusal for a push the fence turned away, naming the epoch's commit the remote fence holds now. */
function fenced(root, { remote, item, epoch }, pushed) {
  const holds = tryGit(root, ['ls-remote', remote, hopFenceRef(item)]).stdout.split(/\s+/u)[0] || 'nothing';
  return new Refused('HOP_FENCED', `the land push for #${item} at hop epoch ${epoch} was refused: the fence ${hopFenceRef(item)} holds ${holds.slice(0, 12)}, not this epoch (${(pushed.stderr || pushed.stdout).split('\n').find(line => line.includes('stale info')) ?? (pushed.stderr || pushed.stdout).split('\n').find(line => line.includes('rejected')) ?? 'stale lease'})`,
    'stop landing: another land job owns the hop; acquire it again if it lapses');
}

/**
 * Push trunk from the batch base to its tip in one atomic push that also checks the fence ref still holds this hop's epoch.
 * Why atomic with two leases: a stale owner's push must leave trunk exactly where it was, so the fence and trunk move together or not at all [C7].
 * With the hop missing, it is the plain push the landing has always made.
 *
 * @param {string} root - The checkout whose HEAD (or `tip`) is pushed.
 * @param {{ remote: string, branch: string, base: string, tip?: string, hop?: { item: number, epoch: number } }} options
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function pushTrunkThroughFence(root, { remote, branch, base, tip = 'HEAD', hop }) {
  if (!hop) return tryGit(root, ['push', remote, `${tip}:${branch}`]);
  const ref = hopFenceRef(hop.item);
  const fence = hopFenceObject(root, hop);
  const pushed = tryGit(root, ['push', '--atomic', `--force-with-lease=${ref}:${fence}`, `--force-with-lease=${branch}:${base}`, remote, `${fence}:${ref}`, `${tip}:${branch}`]);
  if (pushed.status === 0) return pushed;
  const holds = tryGit(root, ['ls-remote', remote, ref]).stdout.split(/\s+/u)[0];
  if (holds !== fence) throw fenced(root, { remote, ...hop }, pushed);
  return pushed;
}
