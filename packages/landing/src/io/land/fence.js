/** The fence ref, the epoch commits and the refusal for a land push fenced by the gate hop's epoch; publish.js does the push itself [C7,#8275]. */
import { tryGit } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { readGateHop } from '../../../../store/index.js';
import { countLeaseLapse } from '../../../../store/index.js';

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

/**
 * The refusal for a push the fence turned away, naming the epoch's commit the remote fence holds now.
 * A lost compare-and-set adds one to the step-aside count of the head item when the caller names `step` ({ board, headItem }), the same count a lapsed lease adds to [C7,#8965].
 */
export function hopFenceRefusal(root, { remote, item, epoch, step }, pushed) {
  if (step?.board && step.headItem !== undefined && step.headItem !== null) {
    try { countLeaseLapse(step.board, step.headItem); } catch { /* The count is a hint; the refusal itself still stands. */ }
  }
  const holds = tryGit(root, ['ls-remote', remote, hopFenceRef(item)]).stdout.split(/\s+/u)[0] || 'nothing';
  const output = (pushed.stderr || pushed.stdout).split('\n');
  return new Refused('HOP_FENCED', `the land push for #${item} at hop epoch ${epoch} was refused: the fence ${hopFenceRef(item)} holds ${holds.slice(0, 12)}, not this epoch (${output.find(line => line.includes('stale info')) ?? output.find(line => line.includes('rejected')) ?? 'stale lease'})`,
    'stop landing: another land job owns the hop; acquire it again if it lapses');
}

/**
 * The fence ref value this owner's epoch may replace: nothing (the ref was never fenced), or the commit of an earlier epoch of the same item; null when the ref holds this epoch or a later one.
 * Why any earlier epoch: an item's gate can be taken more than once between two lands, so the fence may sit several epochs back [C7,#8320].
 */
export function hopFenceLeaseFrom(root, { item, epoch }, holds) {
  if (!holds) return '';
  if (epoch > 1 && hopFencePrevious(root, { item, epoch }) === holds) return holds;
  for (let earlier = epoch - 2; earlier >= 1; earlier--) if (hopFenceObject(root, { item, epoch: earlier }) === holds) return holds;
  return null;
}

/** Whether the board has the fenced hop table; it is created only once a gate driver takes a hop with gate.fencedHop on. */
function hasGateHops(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gate_hop'").get());
}

/**
 * The hop epochs a landing batch carries: each item's epoch from its fenced gate row, read only when `enabled` (gate.fencedHop).
 * An item whose gate never took the row carries none, so turning the setting on does not stop items already gated [C7,#8320].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: number }[]} items
 * @param {{ enabled: boolean }} options
 * @returns {{ item: number, epoch: number }[]}
 */
export function carryLandingHops(db, items, { enabled }) {
  if (enabled !== true || !hasGateHops(db)) return [];
  return items.flatMap(({ id }) => {
    const row = readGateHop(db, id);
    return row && row.epoch >= 1 ? [{ item: id, epoch: row.epoch }] : [];
  });
}

/** Refuse HOP_FENCED when a carried epoch is no longer the one its gate row holds: another owner took the hop after the batch carried it [C7,#8320]. */
export function requireCarriedHops(db, hops) {
  for (const hop of hops) {
    const row = hasGateHops(db) ? readGateHop(db, hop.item) : null;
    if (row?.epoch !== hop.epoch) {
      throw new Refused('HOP_FENCED', `the landing for #${hop.item} carries hop epoch ${hop.epoch}, but its gate row is at epoch ${row?.epoch ?? 'none'} (owner ${row?.owner ?? 'none'})`,
        'stop landing: another owner took the hop; land again from the gate that owns it now');
    }
  }
}
