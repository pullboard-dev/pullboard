import { recordNextIdle as recordNextIdleObservation } from "../../../logic/board/stats.js";
import { stuckReturns } from "../../../logic/rework.js";
import { agentById } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { persistShout } from "../shout.js";

/** Persist next's observed idle cause through the normal ordered actor boundary [R2,N2]. */
export function recordNextIdle(board, options) { return recordNextIdleObservation(board, options, { atomic, logEvent, agentById, shoutStuck }); }

/** Tell the coordinator once per episode that returned work sits open over 1 h while this lane's seat idles [C7,#5765]. */
function shoutStuck(board, agentId) {
  const lane = agentById(board, agentId)?.agent_lane;
  for (const stuck of stuckReturns(board, lane)) {
    persistShout(board, { from: 'rework', to: 'coordinator', detail: { item: stuck.id, stuckReturn: stuck.episode },
      text: `#${stuck.id} is rejected or reopened work open since ${stuck.since}, while ${agentId} in the ${lane} lane gets nothing from next: pullboard show ${stuck.id}` });
  }
}
