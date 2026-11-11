import { approveOutside as applyOutsideApproval } from "../../outside.js";
import { atomic } from "../event/log.js";

/** Record the person's exact-commit owner approval. */
export function approveOutside(board, id, options) { return applyOutsideApproval(board, id, options, atomic); }
