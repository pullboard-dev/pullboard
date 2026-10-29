import { applySpecRowDecisions } from './spec-row-apply.js';
import { writeRowDecisions } from './board-record-row-decisions.js';
import { refreeze } from './board-refreeze.js';
import { insertShout } from './board-shout.js';

/** Apply row decisions and validated cited-item freezes under one board transaction. */
export function applyRowDecisions(board, options) {
  return applySpecRowDecisions(board, options, { ...board.nativePorts, refreeze, writeRowDecisions, notice: message => insertShout(board, message) });
}
