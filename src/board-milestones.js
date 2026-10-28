/** Canonical store composition for roadmap operations; the public board facade retains historical signatures [N26,H16]. */
import * as roadmapMoves from './milestones.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { itemById } from './board-query.js';
import { listItems } from './board-query.js';
import { PERSON } from './board-query.js';
import { milestones } from './board-read-auxiliary.js';

const ports = Object.freeze({ atomic, itemById, listItems, logEvent, milestones, PERSON });

/** Bind canonical store operations for addMilestone without changing its public arguments or result. */
export function addMilestone(board, options) {
  return roadmapMoves.addMilestone(board, options, ports);
}

/** Bind canonical store operations for editMilestone without changing its public arguments or result. */
export function editMilestone(board, name, options) {
  return roadmapMoves.editMilestone(board, name, options, ports);
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
