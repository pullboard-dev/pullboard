import { criticalPathEnabled } from "../../../../src/critical-path-order.js";
import { remainingPaths } from "../../../../src/critical-path-order.js";
import { focusOrder } from "../../../roadmap/index.js";
import { milestoneFocus } from "../../../roadmap/index.js";
import { milestones } from "./board-read-auxiliary.js";
import { milestonePriorities } from "./board-read-auxiliary.js";
import { lineOrderEnabled } from "../../../../src/line-order.js";
import { lineBuildOrder } from "../../../../src/line-order.js";
import { barReadyForOrder } from "../../../../src/line-order.js";
import { listItems } from "./board-query.js";
import { itemFiles } from "../../../../src/item-files.js";
import { ROUTES } from "../../../../src/route-escalation.js";
import { milestoneRanks } from "../../../../src/work-order.js";
import { workOrderCompare } from "../../../../src/work-order.js";
import { foreignBlockers } from "./board.js";

/** Share milestone policy, primary computed order and equal-score path ties across queue and health. */
export function buildOrder(board, { warm = [], agentId, readiness = barReadyForOrder, releasedClaims = [], tierFirst = false, priority } = {}) {
  const milestonePriority = priority ?? milestonePriorities(board);
  const items = listItems(board, { all: true });
  const rank = milestoneRanks(board, milestonePriority, { milestones });
  const recent = new Set(warm);
  const shared = entry => itemFiles(entry).filter(path => recent.has(path)).length;
  const focus = milestoneFocus(board, { milestones });
  const group = item => focus?.ids.has(item.item_id) ? -1 : milestonePriority(item);
  const paths = criticalPathEnabled(board) ? remainingPaths(items, group) : new Map();
  const tieBreak = (first, second) => (paths.get(second.item_id) ?? 0) - (paths.get(first.item_id) ?? 0);
  const fallback = workOrderCompare(board, { priority: milestonePriority, rank, shared, tierFirst, tieBreak }, { milestones, listItems, foreignBlockers }) ?? ((first, second) => milestonePriority(first) - milestonePriority(second)
    || rank(first) - rank(second)
    || ROUTES.indexOf(second.item_route) - ROUTES.indexOf(first.item_route)
    || shared(second) - shared(first) || first.item_id - second.item_id);
  return focusOrder(board, lineOrderEnabled(board)
    ? lineBuildOrder({ agentId, release: milestonePriority, rank, items, ready: item => readiness(board, item), fallback }) : fallback, { milestones });
}
