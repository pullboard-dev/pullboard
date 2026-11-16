import { QUEUE_FAIRNESS_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { lineSettings } from '../../../../state/index.js';
import { localDependencyIds } from '../../../../items/index.js';
import { criticalPathEnabled } from "../../../../items/index.js";
import { remainingPaths } from "../../../../items/index.js";
import { focusOrder } from "../../../../roadmap/index.js";
import { milestoneFocus } from "../../../../roadmap/index.js";
import { milestones } from "./read/shouts.js";
import { milestonePriorities } from "./read/shouts.js";
import { lineOrderEnabled } from "../../../../seats/index.js";
import { lineBuildOrder } from "../../../../seats/index.js";
import { barReadyProblem } from "../../../../verify/index.js";
import { listItems } from "./query.js";
import { itemFiles } from "../../../../items/index.js";
import { ROUTES } from "../../../../seats/index.js";
import { milestoneRanks } from "../../../../items/index.js";
import { workOrderCompare } from "../../../../items/index.js";
import { foreignBlockers } from "../board.js";

/** Share milestone policy, primary computed order and equal-score path ties across queue and health. */
export function buildOrder(board, { warm = [], agentId, readiness = (found, item) => barReadyProblem(found, item) === null, releasedClaims = [], tierFirst = false, priority } = {}) {
  const milestonePriority = priority ?? milestonePriorities(board);
  const items = listItems(board, { all: true });
  const rank = milestoneRanks(board, milestonePriority, { milestones });
  const recent = new Set(warm);
  // A sort calls this per comparison: with no warm files it is always 0, and otherwise each item's count is read once (#8432).
  const sharedCounts = new Map();
  const shared = entry => {
    if (!recent.size) return 0;
    let count = sharedCounts.get(entry.item_id);
    if (count === undefined) sharedCounts.set(entry.item_id, count = itemFiles(entry).filter(path => recent.has(path)).length);
    return count;
  };
  const focus = milestoneFocus(board, { milestones });
  const group = item => focus?.ids.has(item.item_id) ? -1 : milestonePriority(item);
  const paths = criticalPathEnabled(board) ? remainingPaths(items, group) : new Map();
  const tieBreak = (first, second) => (paths.get(second.item_id) ?? 0) - (paths.get(first.item_id) ?? 0);
  const fallback = workOrderCompare(board, { priority: milestonePriority, rank, shared, tierFirst, tieBreak }, { milestones, listItems, foreignBlockers }) ?? ((first, second) => milestonePriority(first) - milestonePriority(second)
    || rank(first) - rank(second)
    || ROUTES.indexOf(second.item_route) - ROUTES.indexOf(first.item_route)
    || shared(second) - shared(first) || first.item_id - second.item_id);
  const ordered = focusOrder(board, lineOrderEnabled(board)
    ? lineBuildOrder({ agentId, release: milestonePriority, rank, items, ready: item => readiness(board, item), fallback }) : fallback, { milestones });
  const rate = (board.executionEngineVersion ?? ENGINE_VERSION) >= QUEUE_FAIRNESS_ENGINE
    ? lineSettings(board).agingMinutes : false;
  if (rate === false) return ordered;
  const byId = new Map(items.map(item => [item.item_id, item]));
  const ready = items.filter(item => item.item_status === 'open' && !item.item_hold_reason
    && localDependencyIds(item).every(id => ['verified', 'withdrawn'].includes(byId.get(id)?.item_status))
    && !foreignBlockers(board, item).length).sort(ordered);
  const at = board.clock.now().getTime();
  const scores = new Map(ready.map((item, position) => {
    const created = Math.max(Date.parse(item.item_created_at), ...localDependencyIds(item).map(id => Date.parse(byId.get(id)?.item_updated_at)).filter(Number.isFinite));
    const waited = Number.isFinite(created) ? Math.max(0, at - created) : 0;
    return [item.item_id, position - waited / (rate * 60_000)];
  }));
  // Aging can reorder eligible work, never manufacture readiness or cross the focus boundary.
  return focusOrder(board, (first, second) => Number(scores.has(second.item_id)) - Number(scores.has(first.item_id))
    || (scores.has(first.item_id) && scores.has(second.item_id) ? scores.get(first.item_id) - scores.get(second.item_id) : 0)
    || ordered(first, second), { milestones });
}
