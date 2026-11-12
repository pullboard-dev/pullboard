import { applySpecRowDecisions } from "../../../../../spec/index.js";
import { writeRowDecisions } from "../record/decisions.js";
import { refreeze } from "../refreeze.js";
import { insertShout } from "../shout.js";

/** Apply row decisions and validated cited-item freezes under one board transaction. */
export function applyRowDecisions(board, options) {
  return applySpecRowDecisions(board, options, { ...board.nativePorts, refreeze, writeRowDecisions, notice: message => insertShout(board, message) });
}
