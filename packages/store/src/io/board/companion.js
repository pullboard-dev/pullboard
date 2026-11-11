import { companionPlan } from "../companion.js";
import { applyCompanionRequest } from "../companion.js";
import { insertItem } from "./add.js";
import { validateItemAddition } from "./add.js";

/** Read the canonical request plan before a CLI performs any authorized baseline work. */
export function planCompanion(board, options) { return companionPlan(board, options, validateItemAddition); }

/** The single ordered operation permitted to create a child in a different lane. */
export function requestCompanion(board, options) {
  return applyCompanionRequest(board, options, { validateAddition: validateItemAddition, insertItem });
}
