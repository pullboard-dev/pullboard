/** The withdraw and reopen tables wired to the board's own move declarations and cause check, so callers and replays share one source [C7,#8258]. */
import { causeProblem } from '../../../../store/index.js';
import { MOVES, WITHDRAW_AS_MET_ENGINE } from '../../../../state/index.js';
import { reopenEngine } from '../../logic/table/reopen.table.js';
import { withdrawEngine } from '../../logic/table/withdraw.table.js';

/** The starting states the lifecycle machine declares for a verb. */
const startsFor = (verb) => MOVES.find((move) => move.verb === verb).from;

/**
 * The withdraw rules and table over the machine's own starting states.
 * Why: the pure table takes them by injection; this is the one place that hands it the live ones.
 *
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function boardWithdrawEngine() {
  return withdrawEngine({ from: startsFor('withdraw'), metEngine: WITHDRAW_AS_MET_ENGINE });
}

/**
 * The reopen rules and table over the machine's own starting states and the store's cause check.
 *
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function boardReopenEngine() {
  return reopenEngine({ causeProblem, states: startsFor('reopen') });
}
