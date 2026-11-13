/** The handlers the API's pool workers run, each on its own board connection, never on the request thread [A2,C7]. */
import * as store from '../../../../store/index.js';
import { boardJobsCall } from '../main.js';
import { withBoard } from '../main.js';

/** The longest route text a stall record keeps. */
const ROUTE_CHARS = 200;

/**
 * The pool's handlers for one worker: the runner job queue (claim, renew, release, progress, receipt) and the
 * request thread's stall records.
 *
 * @param {{ boardOpeners: object }} ports
 * @param {{ isMain?: boolean }} options
 */
export function poolHandlers(ports, { isMain }) {
  const { boardOpeners } = ports;
  return {
    /** One runner job queue call on the board, as POST /api/v1/boards/:id/jobs answers it [P7]. */
    jobs: (call) => boardJobsCall(call, isMain, boardOpeners),
    /**
     * Record a request-thread stall as an api_stall event on the served board the route names, or on every served
     * board when it names none, so the board shows which route froze the API and for how long.
     */
    stall({ projects, by, board = null, route, lagMs }) {
      let recorded = 0;
      for (const project of projects) {
        try {
          withBoard(project.root, (current) => {
            if (board !== null && store.boardId(current) !== board) return;
            store.logEvent(current, by, 'api_stall', null, { route: String(route).slice(0, ROUTE_CHARS), lagMs: Math.round(lagMs) });
            recorded++;
          }, isMain, boardOpeners);
        } catch { /* An unreadable board misses this record; the others still get it. */ }
      }
      return { recorded };
    },
  };
}
