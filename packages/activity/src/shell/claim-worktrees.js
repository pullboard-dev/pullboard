import { activityWorkingFiles } from './activity-inbox.js';

/** Observe each claimed seat from Git, including staged, unstaged, untracked and committed changes. */
export function claimWorktrees(items, agents) {
  const seats = new Map(agents.map(agent => [agent.agent_id, agent.agent_path]));
  return new Map(items.filter(item => item.item_status === 'claimed').map(item => {
    const root = seats.get(item.item_owner);
    return [item.item_id, root ? activityWorkingFiles(root, [item]) : { files: [], unknown: true }];
  }));
}

/** Name every live overlap and out-of-scope edit to the holder, without mutating board history. */
export function claimOverlapLines(items, agents, agentId, project) {
  const observations = claimWorktrees(items, agents);
  const overlaps = project(items, observations);
  return items.filter(item => item.item_status === 'claimed' && item.item_owner === agentId).flatMap(item => {
    const found = overlaps.get(item.item_id);
    return [
      ...found.overlaps.map(other => `#${item.item_id} overlaps #${other.item} (${other.builder}) on ${other.files.join(', ')}`),
      ...found.outOfScope.map(other => `#${item.item_id} may be out of scope: #${other.item} names ${other.files.join(', ')}`),
      ...(found.unknown ? [`#${item.item_id} worktree changes are unavailable; overlap is unknown`] : []),
    ];
  });
}
