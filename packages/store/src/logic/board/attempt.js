import { logEvent } from "../../io/board/event/log.js";

/**
 * Record one unattended attempt at an item (A11): which try, how long, and how it ended, so each
 * route's record shows whether its tier pays.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, n: number, seconds: number, result: string }} attempt
 */
export function recordAttempt(board, id, { agentId, n, seconds, result }) {
  logEvent(board, agentId, 'attempt', id, { n, seconds, result });
}

