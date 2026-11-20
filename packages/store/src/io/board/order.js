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
  // Only the line order reads every item; the critical path counts unfinished items only and aging reads the open list [C7,#10795].
  let listed = null;
  const allItems = () => listed ??= listItems(board, { all: true });
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
  const paths = criticalPathEnabled(board) ? remainingPaths(listItems(board), group) : new Map();
  const tieBreak = (first, second) => (paths.get(second.item_id) ?? 0) - (paths.get(first.item_id) ?? 0);
  const fallback = workOrderCompare(board, { priority: milestonePriority, rank, shared, tierFirst, tieBreak }, { milestones, listItems, foreignBlockers }) ?? ((first, second) => milestonePriority(first) - milestonePriority(second)
    || rank(first) - rank(second)
    || ROUTES.indexOf(second.item_route) - ROUTES.indexOf(first.item_route)
    || shared(second) - shared(first) || first.item_id - second.item_id);
  const ordered = focusOrder(board, lineOrderEnabled(board)
    ? lineBuildOrder({ agentId, release: milestonePriority, rank, items: allItems(), ready: item => readiness(board, item), fallback }) : fallback, { milestones });
  const rate = (board.executionEngineVersion ?? ENGINE_VERSION) >= QUEUE_FAIRNESS_ENGINE
    ? lineSettings(board).agingMinutes : false;
  if (rate === false) return ordered;
  const items = listItems(board);
  const byId = agingDependencies(board, items);
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

/**
 * The unfinished items by id, plus the status and update time of every finished item an open item waits on.
 * Why: aging needs only whether an open item's dependencies are verified or withdrawn and when they last changed,
 * so one read of those ids replaces a copy of every item on the board [C7,#10795]. A redirected item reads as
 * missing, as the item list leaves it out.
 *
 * @param {any} board
 * @param {any[]} unfinished the open item list
 * @returns {Map<number, any>}
 */
function agingDependencies(board, unfinished) {
  const byId = new Map(unfinished.map(item => [item.item_id, item]));
  const wanted = [...new Set(unfinished.filter(item => item.item_status === 'open').flatMap(item => localDependencyIds(item)))].filter(id => !byId.has(id));
  if (!wanted.length) return byId;
  const rows = board.db.prepare(`SELECT item_id, item_status, item_updated_at FROM item WHERE item_id IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM board_meta redirect WHERE redirect.meta_key='item_redirect:' || item.item_id)`).all(JSON.stringify(wanted));
  for (const row of rows) byId.set(row.item_id, row);
  return byId;
}
