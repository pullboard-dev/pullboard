/** Validate retained item dependencies independently of board write orchestration. */
import { itemById } from "../query.js";
import { Refused } from "../../../../../kernel/index.js";
import * as itemDependencies from "../../../../../items/index.js";

/** Validate that dependencies exist, remain usable, and cannot lead back to the edited item. */
export function validateItemDependencies(board, itemId, after) {
  itemDependencies.dependencyValues(after);
  const direct = itemDependencies.localDependencyIds(after).map((dependency) => itemById(board, dependency));
  const withdrawn = direct.find((dependency) => dependency.item_status === 'withdrawn');
  if (withdrawn) {
    throw new Refused('WITHDRAWN', `item #${withdrawn.item_id} is withdrawn; nothing can wait on it`);
  }
  if (itemId === null) return;

  const visited = new Set();
  const pending = itemDependencies.localDependencyIds(after);
  while (pending.length) {
    const dependency = pending.pop();
    if (dependency === itemId) {
      throw new Refused('DEPENDENCY_CYCLE', `item #${itemId} cannot wait on itself through its dependencies; change --after to remove the cycle`);
    }
    if (visited.has(dependency)) continue;
    const item = itemById(board, dependency);
    visited.add(dependency);
    pending.push(...itemDependencies.localDependencyIds(item));
  }
}
