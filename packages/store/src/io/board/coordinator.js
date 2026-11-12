import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { COORDINATOR } from "../../../../config/index.js";
import { register } from "./register.js";

/**
 * The coordinator, registered at the main checkout. Only the main checkout of this repo can reach
 * this board, so when the repo moved on disk the coordinator follows it instead of refusing.
 *
 * @param {any} board
 * @param {string} path
 * @returns {string}
 */
export function ensureCoordinator(board, path) {
  const existing = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id = ?').get(COORDINATOR);
  if (!existing) return register(board, { lane: COORDINATOR, path });
  if (existing.agent_path !== path) {
    atomic(board, () => {
      board.db.prepare('UPDATE agent SET agent_path = ? WHERE agent_id = ?').run(path, COORDINATOR);
      logEvent(board, COORDINATOR, 'moved', null, { path });
    });
  }
  return COORDINATOR;
}
