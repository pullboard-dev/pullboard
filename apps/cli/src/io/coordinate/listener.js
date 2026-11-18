/** What pullboard coordinate says about the listener and the agents to start: the inbox feed the pullboard-run skill reads, plus its builder and verifier tasks [C7,#8516]. */
import { peekShouts } from '../../../../../packages/store/index.js';
import { unreadCount } from '../../../../../packages/store/index.js';

/** The coordinator's inbox waits on these, so the person never has to relay them. */
export const LISTENER_WAKES = 'each new shout to coordinator, all or person, each decision or request on an item thread, and each reject';

/**
 * Confirm the listener is armed: the coordinator's inbox feed answers and says what wakes it.
 * Reading the feed writes nothing, so arming twice is the same as arming once.
 *
 * @param {any} board - An open board.
 * @param {string} coordinator - The coordinator's agent id.
 * @returns {string[]} The lines to print.
 */
export function listenerLines(board, coordinator) {
  const unread = unreadCount(board, coordinator);
  peekShouts(board, coordinator, 1);
  return [`listener armed: pullboard inbox is the feed; it wakes you on ${LISTENER_WAKES}; ${unread} unread now`];
}

/**
 * The builder and verifier starts, as pullboard-run gives them.
 *
 * @param {string[]} lanes - Lanes with open work.
 * @returns {string[]} The lines to print.
 */
export function startLines(lanes) {
  return [
    'Start these agents:',
    ...lanes.map(lane => `  builder (${lane}): pullboard worktree ${lane} --model "<model name>"; task: run pullboard next, build the item, commit, pullboard submit, repeat`),
    '  verifier: pullboard worktree review --model "<model name>"; start it as a separate session, never your subagent; task: follow the pullboard-verify skill, pullboard next --verify, record the verdict, repeat',
  ];
}
