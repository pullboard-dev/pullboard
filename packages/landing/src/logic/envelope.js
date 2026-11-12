/** Build a normal hooked first-parent publication envelope around an already-corrected side tree [B3,C7]. */
import { git } from '../../../git/index.js';
import { isClean } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/** Refuse source mutation without rewriting or cleaning up another operation's Git state. */
function changedEnvelope() {
  return new Refused('LAND_SOURCE_CHANGED',
    'inspect the landing worktree and normal commit-hook output; rebuild the exact clean side tree before gating its envelope');
}

/**
 * Use ordinary checkout, merge and commit so all normal hooks run. The caller owns the landing lease and
 * must save the returned tip/items only after success; failure deliberately leaves Git state for inspection.
 * Badges, engine assignments and doctrine corrections must already be committed on the side tip.
 * @param {string} root owned clean landing worktree
 * @param {{base:string,side:string,items:object[],message:string}} options immutable pre-gate inputs
 * @returns {{tip:string,tree:string,items:object[]}} envelope and first-containing item identities
 */
export function createLandingEnvelope(root, { base, side, items, message }) {
  const object = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  if (!object.test(base ?? '') || !object.test(side ?? '') || !Array.isArray(items) || !items.length
    || typeof message !== 'string' || !message.trim() || !isClean(root)
    || git(root, ['status', '--porcelain', '--untracked-files=all']).trim()
    || git(root, ['rev-parse', 'HEAD']).trim() !== side) throw changedEnvelope();
  const tree = git(root, ['rev-parse', '--verify', `${side}^{tree}`]).trim();
  git(root, ['merge-base', '--is-ancestor', base, side]);
  if (base === side) throw changedEnvelope();
  git(root, ['checkout', '--detach', base]);
  git(root, ['merge', '--no-ff', '--no-commit', side]);
  if (git(root, ['write-tree']).trim() !== tree) throw changedEnvelope();
  git(root, ['commit', '-m', message]);
  const tip = git(root, ['rev-parse', 'HEAD']).trim();
  const parents = git(root, ['rev-list', '--parents', '-n', '1', tip]).trim().split(/\s+/u);
  if (parents.length !== 3 || parents[1] !== base || parents[2] !== side
    || git(root, ['rev-parse', `${tip}^{tree}`]).trim() !== tree || !isClean(root)
    || git(root, ['status', '--porcelain', '--untracked-files=all']).trim()) throw changedEnvelope();
  return { tip, tree, items: items.map(entry => ({ ...entry, merge: tip })) };
}
