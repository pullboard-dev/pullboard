import { PERSON } from "../query.js";
import { now } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { Refused } from "../../../../../kernel/index.js";
import { coordinatorOnly } from "../../board.js";

/**
 * Hold a lane (N22): `next` there claims nothing and names the reason, so a pause lives on the board
 * and not in a message. Work already claimed goes on. Only the coordinator holds and releases.
 *
 * @param {any} board
 * @param {string} lane
 * @param {{ agentId: string, reason: string, asPerson?: boolean, channel?: string }} hold
 */
export function holdLane(board, lane, { agentId, reason, asPerson = false, channel = 'terminal' }) {
  coordinatorOnly(agentId, 'holds a lane');
  if (asPerson && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'record the person hold through the terminal or the view; run pullboard view');
  const by = asPerson ? PERSON : agentId;
  if (!String(reason ?? '').trim()) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${lane} --reason "why"`);
  atomic(board, () => {
    board.db
      .prepare(
        `INSERT INTO hold (hold_lane, hold_reason, hold_by, hold_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (hold_lane) DO UPDATE SET hold_reason = excluded.hold_reason, hold_by = excluded.hold_by, hold_at = excluded.hold_at`,
      )
      .run(lane, reason.trim(), by, now(board));
    logEvent(board, by, 'hold', null, { lane, reason: reason.trim(), ...(asPerson ? { channel } : {}) });
  });
}
