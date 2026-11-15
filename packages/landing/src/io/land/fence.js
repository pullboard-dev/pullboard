/** The fence ref, the epoch commits and the refusal for a land push fenced by the gate hop's epoch; publish.js does the push itself [C7,#8275]. */
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

/** The value the remote fence ref must hold before this epoch takes it: the epoch before's commit, or '' (absent) for the first epoch. */
export function hopFencePrevious(root, { item, epoch }) {
  return epoch === 1 ? '' : hopFenceObject(root, { item, epoch: epoch - 1 });
}

/** The refusal for a push the fence turned away, naming the epoch's commit the remote fence holds now. */
export function hopFenceRefusal(root, { remote, item, epoch }, pushed) {
  const holds = tryGit(root, ['ls-remote', remote, hopFenceRef(item)]).stdout.split(/\s+/u)[0] || 'nothing';
  const output = (pushed.stderr || pushed.stdout).split('\n');
  return new Refused('HOP_FENCED', `the land push for #${item} at hop epoch ${epoch} was refused: the fence ${hopFenceRef(item)} holds ${holds.slice(0, 12)}, not this epoch (${output.find(line => line.includes('stale info')) ?? output.find(line => line.includes('rejected')) ?? 'stale lease'})`,
    'stop landing: another land job owns the hop; acquire it again if it lapses');
}
