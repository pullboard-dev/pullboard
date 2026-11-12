import { atomic } from "../../io/board/event/log.js";
import { logEvent } from "../../io/board/event/log.js";
import { current } from "../../io/board/query.js";
import { moveItem } from "../../io/board.js";
import { COORDINATOR } from "../../../../config/index.js";
import { IN_STATE } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/light.js";
import { ROUTES } from "../../../../seats/browser.js";

/**
 * Hand an item one tier up (B15): its builder could not get it green, so it goes back open, routed
 * to the next stronger model, with what was tried pinned and why it failed in the log. A strong
 * item stays strong and goes back to the coordinator's attention.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, attempt?: string, rejections?: object[] }} why
 * @returns {{ from: string, to: string }}
 */
export function escalate(board, id, { agentId, note, attempt = '', rejections }) {
  return atomic(board, () => {
    const nextRoute = (route) => ROUTES[Math.min(ROUTES.indexOf(route) + 1, ROUTES.length - 1)];
    const item = moveItem(board, id, 'escalate', {
      checks: {
        joined: null,
        noteGiven: () => (note.trim() ? null : new Refused('NOTE_REQUIRED', 'say what was tried and how it failed: --note "..."')),
        holderOrCoordinator: (found) => {
          const live = current(board, found);
          const isHolder = live.item_status === 'claimed' && live.item_owner === agentId;
          return isHolder || agentId === COORDINATOR ? null : new Refused('NOT_YOURS', `item #${id} is not claimed by you; only its holder or the coordinator escalates it`);
        },
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${current(board, found).item_status}; escalate open or claimed work only`),
      },
      set: (found) => ({ item_route: nextRoute(found.item_route), item_owner: null, item_lease_until: null }),
    });
    const from = item.item_route;
    const to = nextRoute(from);
    logEvent(board, agentId, 'escalate', id, {
      from, to, note: note.trim(), ...(attempt ? { attempt } : {}), ...(rejections ? { rejections } : {}),
    });
    return { from, to };
  });
}

