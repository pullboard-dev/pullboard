/** Prepare exact native train evidence at origin; replicas consume only the sealed request [C7,H16]. */
import { checkedLandingCommit } from '../../../store/index.js';
import { getItem } from '../../../store/index.js';
import { landingBatches } from '../../../store/index.js';
import { COORDINATOR } from '../../../config/index.js';
import { contains } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { patchId } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { readTrainLandingReceipt } from './train/receipt.js';
import { prepareTrainCheckRepointPlan } from './train/repoints.js';

/** Derive a one-time migration annotation from the exact commit message and real parent objects. */
function migrationEnvelope(root, board, commit, base) {
  const body = git(root, ['show', '-s', '--format=%B', commit]);
  const markers = body.split('\n').filter(line => line.startsWith('Pullboard-Migration:'));
  if (!markers.length) return {};
  const parents = git(root, ['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/u);
  if (markers.length !== 1 || markers[0] !== `Pullboard-Migration: ${base}` || parents.length !== 3
    || parents[1] !== base || landingBatches(board).some(batch => batch.state === 'landed'
      && batch.proof?.receipt && batch.tip !== commit)) {
    throw new Refused('LAND_RECEIPT_UNBOUND', 'use the once-only migration envelope with its actual published first parent');
  }
  return { migration: { version: 1, publishedBase: base, side: parents[2], tip: commit } };
}

/** Bind the complete batch membership to actual reviewed sources and the native receipt's exact envelope. */
export function prepareTrainLanding(root, board, ids, commit, receiptId) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(ids).size !== ids.length) throw new Refused('USAGE', 'name each batch item once with --items 1,2,3');
  const receipt = readTrainLandingReceipt(root, board, receiptId, commit);
  const trunk = mainCheckout(root);
  if (!trunk?.commit || !contains(root, commit, trunk.commit)) {
    throw new Refused('NOT_MERGED', 'the gated envelope must already be on the primary trunk before recording its landing');
  }
  const parent = tryGit(root, ['rev-parse', '--verify', `${commit}^1`]);
  if (parent.status !== 0) throw new Refused('LAND_RECEIPT_UNBOUND', 'a train envelope needs its real first-parent trunk base');
  const items = ids.map(id => {
    const item = getItem(board, id);
    if (item.item_status !== 'verified') throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; record verified work only`);
    const checked = checkedLandingCommit(board, item);
    const oldPatch = item.item_claim_head ? patchId(root, item.item_claim_head, checked) : null;
    const currentPatch = oldPatch ? patchId(root, parent.stdout, commit) : null;
    if (!contains(root, checked, commit) && !(ids.length === 1 && oldPatch && oldPatch === currentPatch)) {
      throw new Refused('NOT_MERGED', `the envelope does not carry the reviewed source for item #${id}`);
    }
    return { id, commit: item.item_commit, merge: commit,
      ...(checked === item.item_commit ? {} : { reviewedCommit: checked }) };
  });
  const batch = {
    version: 1, id: `train-${receipt.id}`, state: 'trunk', base: parent.stdout, tip: commit,
    root, branch: trunk.branch, owner: 'coordinator-train',
    logPath: git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) + `/pullboard/gate-receipts/${receipt.id}.json`,
    items, proof: { tree: receipt.tree }, ...migrationEnvelope(root, board, commit, parent.stdout),
  };
  return { agentId: COORDINATOR, receipt, batch,
    checkRepointPlan: prepareTrainCheckRepointPlan(root, board, batch.base, batch.tip) };
}

/** Recover an existing native batch from board history; caller batch fields never replace its sealed identity. */
export function prepareNativeTrainLanding(root, board, id, receiptId) {
  const batch = landingBatches(board).find(entry => entry.id === id);
  if (!batch || !['trunk', 'pushed', 'landed'].includes(batch.state) || batch.root !== root) {
    throw new Refused('LAND_BATCH', 'finish the exact recorded native batch from its owned worktree');
  }
  // A terminal immutable retry returns the already-recorded landing; a fresh finish still needs current authority.
  const receipt = readTrainLandingReceipt(root, board, receiptId, batch.tip, { historical: batch.state === 'landed' });
  if (batch.proof?.tree !== receipt.tree || batch.items.some(entry => entry.merge !== batch.tip)
    || git(root, ['rev-parse', 'HEAD']).trim() !== batch.tip) {
    throw new Refused('LAND_RECEIPT_UNBOUND', 'gate and retain the exact native batch envelope before finishing it');
  }
  return { agentId: COORDINATOR, nativeBatch: id, batch, receipt,
    checkRepointPlan: batch.state === 'landed' ? null : prepareTrainCheckRepointPlan(root, board, batch.base, batch.tip) };
}
