import { applyOutsideIntake } from "../../outside.js";
import { atomic } from "../event/log.js";
import { moveItem } from "../../board.js";
import { addItem } from "../add.js";
import { validateItemAddition } from "../add.js";

/** File or refresh an outside source through the ordinary ordered engine. */
export function intakeOutside(board, options) { return applyOutsideIntake(board, options, { atomic, addItem, moveItem, validateItemAddition }); }
