import { coordinatorMilestoneRelease } from '../../../../stats/light.js';
/** Canonical store composition for roadmap operations; the public board facade retains historical signatures [N26,H16]. */
import * as roadmapMoves from "../../../../roadmap/index.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { itemById } from "./query.js";
import { listItems } from "./query.js";
import { PERSON } from "./query.js";
import { milestones } from "./read/shouts.js";

const ports = Object.freeze({ atomic, itemById, listItems, logEvent, milestones, PERSON, coordinatorMilestoneRelease });

/** Bind canonical store operations for addMilestone without changing its public arguments or result. */
export function addMilestone(board, options) {
  return roadmapMoves.addMilestone(board, options, ports);
}

/** Bind canonical store operations for editMilestone without changing its public arguments or result. */
export function editMilestone(board, name, options) {
  return roadmapMoves.editMilestone(board, name, options, ports);
}

/** Bind canonical store operations for placing a new item by rule inside its add transaction. */
export function placeNewItem(board, id, item) {
  return roadmapMoves.placeNewItem(board, id, item, ports);
}

/** Bind canonical store operations for editMilestoneItems without changing its public arguments or result. */
export function editMilestoneItems(board, name, options) {
  return roadmapMoves.editMilestoneItems(board, name, options, ports);
}

/** Bind canonical store operations for orderMilestoneItems without changing its public arguments or result. */
export function orderMilestoneItems(board, name, options) {
  return roadmapMoves.orderMilestoneItems(board, name, options, ports);
}

/** Bind canonical store operations for moveMilestone without changing its public arguments or result. */
export function moveMilestone(board, name, options) {
  return roadmapMoves.moveMilestone(board, name, options, ports);
}

/** Bind canonical store operations for removeMilestone without changing its public arguments or result. */
export function removeMilestone(board, name, options) {
  return roadmapMoves.removeMilestone(board, name, options, ports);
}

/** Bind canonical store operations for shipMilestone without changing its public arguments or result. */
export function shipMilestone(board, name, options) {
  return roadmapMoves.shipMilestone(board, name, options, ports);
}

/** Bind canonical store operations for roadmap without changing its public arguments or result. */
export function roadmap(board, resolveExternal = null) {
  return roadmapMoves.roadmap(board, resolveExternal, ports);
}
