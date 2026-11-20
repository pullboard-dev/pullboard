/** Unit-item Hu priorities use only the recorded dependency graph, never invented duration estimates [N2,H16]. */
import { ENGINE_VERSION } from "../../../../state/light.js";
import { CRITICAL_PATH_ENGINE } from "../../../../state/light.js";
import { briefFiles } from "../brief.js";
import { itemFiles } from "../files.js";

/** Historical next moves retain their original collision and ordering policy. */
export function criticalPathEnabled(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= CRITICAL_PATH_ENGINE;
}

/** Count unfinished nodes on the longest successor path within each milestone group, in linear graph time. */
export function remainingPaths(items, group) {
  const active = new Map(items.filter(item => !['verified', 'withdrawn'].includes(item.item_status))
    .map(item => [item.item_id, item]));
  const predecessors = new Map([...active.keys()].map(id => [id, []]));
  const outstanding = new Map([...active.keys()].map(id => [id, 0]));
  for (const item of active.values()) {
    for (const id of new Set((item.item_after ?? '').split(',').filter(Boolean).map(Number))) {
      const before = active.get(id);
      if (!before || group(before) !== group(item)) continue;
      predecessors.get(item.item_id).push(id);
      outstanding.set(id, outstanding.get(id) + 1);
    }
  }
  const paths = new Map([...active.keys()].map(id => [id, 1]));
  const queue = [...outstanding].filter(([, count]) => count === 0).map(([id]) => id);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    for (const before of predecessors.get(id)) {
      paths.set(before, Math.max(paths.get(before), paths.get(id) + 1));
      outstanding.set(before, outstanding.get(before) - 1);
      if (!outstanding.get(before)) queue.push(before);
    }
  }
  // Normal moves refuse dependency cycles. A damaged historical graph must still give a bounded order.
  for (const [id, count] of outstanding) if (count) paths.set(id, 1);
  return paths;
}

/** Index live declared/changed paths once; an overlap lowers preference but never eligibility. */
function overlapCounts(items, releasedClaims) {
  const holders = new Map();
  for (const item of items) {
    if (releasedClaims.has(item.item_id)) continue;
    if (!['claimed', 'submitted'].includes(item.item_status)
      && !(item.item_status === 'verified' && !item.item_merged_commit)) continue;
    for (const path of itemFiles(item)) {
      if (!holders.has(path)) holders.set(path, new Set());
      holders.get(path).add(item.item_id);
    }
  }
  return new Map(items.map(item => {
    const overlaps = new Set(briefFiles(item.item_brief ?? '').flatMap(path => [...(holders.get(path) ?? [])]));
    overlaps.delete(item.item_id);
    return [item.item_id, overlaps.size];
  }));
}

/** Order by release/path/overlap; health may omit only the claims its suggested release would remove. */
export function criticalPathOrder({ items, group, fallback, releasedClaims = [] }) {
  const paths = remainingPaths(items, group);
  const overlaps = overlapCounts(items, new Set(releasedClaims));
  return (first, second) => group(first) - group(second)
    || (paths.get(second.item_id) ?? 0) - (paths.get(first.item_id) ?? 0)
    || (overlaps.get(first.item_id) ?? 0) - (overlaps.get(second.item_id) ?? 0)
    || fallback(first, second);
}
