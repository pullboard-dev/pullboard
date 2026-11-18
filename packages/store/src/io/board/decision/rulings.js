import { Refused } from "../../../../../kernel/index.js";
import { TYPED_REQUEST_CAUSES } from "../../requests.js";

/**
 * Every ruling recorded under one cause key, newest first: the answers answerDecision wrote with that cause (#1444).
 *
 * @param {any} board
 * @param {string} cause - one key of TYPED_REQUEST_CAUSES
 * @returns {{ shout: number, text: string, answerer: string, at: string }[]}
 */
export function rulingsByCause(board, cause) {
  if (!TYPED_REQUEST_CAUSES.includes(cause)) throw new Refused("RULING_CAUSE", `a ruling cause is one of ${TYPED_REQUEST_CAUSES.join(", ")}`);
  return board.db.prepare(`SELECT reply.shout_id AS shout, reply.shout_text AS text, reply.shout_from AS answerer, reply.shout_at AS at
    FROM event JOIN shout reply ON reply.shout_id = json_extract(event.event_detail, '$.shout')
    WHERE event.event_kind = 'answer' AND json_extract(event.event_detail, '$.cause') = ?
    ORDER BY reply.shout_id DESC`).all(cause);
}
