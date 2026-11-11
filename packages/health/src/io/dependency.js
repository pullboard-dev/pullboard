/** Capture a dependent claim using the actual validated item checkout and native resource custody [C7,B4]. */
import { dependencyWaiters } from '../../../items/index.js';
import { dependencyWorkAt } from '../../../items/index.js';
import { observeStaleWorkAt } from './stale/observation/work.js';
import { staleRunQuiet } from './stale/observation/run.js';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** Resource custody can retain a claim even on the cheap lapsed-only path; it needs no Git read. */
export function dependencyCustodyQuiet(board, item) {
  const seat = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(item.item_owner);
  if (!seat?.agent_path) return false;
  return staleRunQuiet(seat.agent_path, { item: String(item.item_id), agent: item.item_owner,
    roots: [join(dirname(seat.agent_path), `${basename(seat.agent_path)}-item-${item.item_id}`)] });
}

/** Unknown identity, unreadable work or any retained runner holder proves no inactivity. */
export function observeDependencyWork(board, item) {
  try {
    const root = board.enginePorts.claimedItemRoot?.(board, item);
    if (!root || !staleRunQuiet(root, { item: String(item.item_id), agent: item.item_owner })) return null;
    const work = observeStaleWorkAt(root);
    return work.available === true && work.commitAt ? { root, commitAt: work.commitAt } : null;
  } catch { return null; }
}

/** Reuse the captured claim binding while replacing generic inactivity with the dependency's exact work boundary. */
export function strandedDependency(board, item, row, observedAt, limit, work) {
  const dependents = dependencyWaiters(board, item.item_id).map(entry => entry.item_id);
  if (!dependents.length) return null;
  if (!work) return null;
  const workActivity = dependencyWorkAt(board, item, work.commitAt, observedAt);
  if (!workActivity || observedAt - Date.parse(workActivity) < limit) return null;
  return { ...row, idle: 'dependency', commitAt: work.commitAt, workRoot: work.root, workActivity,
    idleMs: observedAt - Date.parse(workActivity), dependents, resourceQuiet: true };
}
