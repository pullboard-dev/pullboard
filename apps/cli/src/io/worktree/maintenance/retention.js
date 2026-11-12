/** Durable metadata for deferred withdrawal cleanup; target worktrees are never inspected [B3,C7]. */
import { isAbsolute } from 'node:path';
import { repoInfo } from '../../../../../../packages/git/index.js';
import { readMaintenanceState } from './observation.js';
import { withMaintenanceLock } from './observation.js';
import { writeMaintenanceState } from './observation.js';

/** Record or clear retention only under the repository maintenance lock, preserving other observations. */
export async function recordMaintenanceRetention(root, { path, item, agent, reason }, { now = Date.now(), clear = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path))
    throw new TypeError('maintenance retention needs an absolute path');
  if (typeof clear !== 'boolean' || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    throw new TypeError('maintenance retention needs a valid time and clear flag');
  if (!clear && (!Number.isSafeInteger(item) || item < 1 || typeof agent !== 'string' || !agent.trim()
    || agent.length > 256 || typeof reason !== 'string' || !reason.trim() || reason.length > 4096))
    throw new TypeError('maintenance retention needs an item, agent and reason');
  const { commonDir } = repoInfo(root);
  return withMaintenanceLock(commonDir, async () => {
    const state = readMaintenanceState(commonDir);
    const prior = Object.hasOwn(state.trees, path) ? state.trees[path] : undefined;
    if (prior !== undefined && (!prior || typeof prior !== 'object' || Array.isArray(prior)))
      throw new Error('maintenance retention observation is malformed');
    if (clear && !Object.hasOwn(prior ?? {}, 'retainedWithdrawal')) return false;
    const next = { ...prior };
    if (clear) delete next.retainedWithdrawal;
    else next.retainedWithdrawal = { item, agent, at: new Date(now).toISOString(), reason };
    state.trees[path] = next;
    writeMaintenanceState(commonDir, state);
    return true;
  });
}

/** Project recorded metadata without observing any target path or inventing retention ages. */
export function retainedMaintenanceHealth(state) {
  const trees = state?.trees;
  if (!trees || typeof trees !== 'object' || Array.isArray(trees)) return [];
  return Object.entries(trees).flatMap(([path, tree]) => {
    const retained = tree?.retainedWithdrawal;
    if (!isAbsolute(path) || !retained || typeof retained.at !== 'string' || !Number.isFinite(Date.parse(retained.at))
      || typeof retained.reason !== 'string' || !retained.reason.trim()
      || !Number.isSafeInteger(retained.item) || retained.item < 1) return [];
    return [{ path, since: retained.at, reason: retained.reason, kind: 'withdrawal-retained', item: retained.item }];
  });
}
