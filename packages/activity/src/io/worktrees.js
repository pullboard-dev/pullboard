import { activityWorkingFiles } from './inbox.js';
import { checkoutHead } from '../../../git/index.js';
import { checkoutRefCommit } from '../../../git/index.js';
import { commandObservation } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';

/** Observe each claimed seat from Git, including staged, unstaged, untracked and committed changes. */
export function claimWorktrees(items, agents) {
  const seats = new Map(agents.map(agent => [agent.agent_id, agent.agent_path]));
  return new Map(items.filter(item => item.item_status === 'claimed').map(item => {
    const root = seats.get(item.item_owner);
    if (!root) return [item.item_id, { files: [], unknown: true }];
    // One command reads each seat's worktree once, however many of its steps ask (next asked four times).
    return [item.item_id, commandObservation(JSON.stringify(['claim-worktree', root, item.item_claim_head ?? null]), () => {
      // A merged trunk commit belongs to main, not this claim. Retain the claim anchor when main is unavailable.
      // A checkout sitting at main's own commit has that commit as its merge base, with no Git process to ask.
      const head = checkoutHead(root);
      const atMain = head !== undefined && head === checkoutRefCommit(root, 'refs/heads/main');
      const common = atMain ? { status: 0, stdout: head } : tryGit(root, ['merge-base', 'HEAD', 'main']);
      const base = common.status === 0 ? common.stdout.trim() : '';
      // A commit is its own ancestor, so the common case of an unmoved claim base needs no Git process.
      const validBase = /^[a-f0-9]{40}$/u.test(base) && /^[a-f0-9]{40}$/u.test(item.item_claim_head ?? '')
        && (item.item_claim_head === base || tryGit(root, ['merge-base', '--is-ancestor', item.item_claim_head, base]).status === 0);
      return activityWorkingFiles(root, [{ ...item, item_claim_head: validBase ? base : item.item_claim_head }]);
    })];
  }));
}

/** Name every live overlap and out-of-scope edit to the holder, without mutating board history. */
export function claimOverlapLines(items, agents, agentId, project, observations = null) {
  if (!items.some(item => item.item_status === 'claimed' && item.item_owner === agentId)) return [];
  observations ??= claimWorktrees(items, agents);
  const overlaps = project(items, observations);
  return items.filter(item => item.item_status === 'claimed' && item.item_owner === agentId).flatMap(item => {
    const found = overlaps.get(item.item_id);
    return [
      ...found.overlaps.map(other => `#${item.item_id} overlaps #${other.item} (${other.builder}) on ${other.files.join(', ')}`),
      ...found.outOfScope.map(other => `#${item.item_id} may be out of scope: #${other.item} names ${other.files.join(', ')}`),
      // A claim maintenance has not observed yet says nothing; only a failed observation is named unknown.
      ...(found.unknown && !observations.get(item.item_id)?.unrecorded ? [`#${item.item_id} worktree changes are unavailable; overlap is unknown`] : []),
    ];
  });
}
