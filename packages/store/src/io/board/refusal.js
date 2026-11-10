import { logEvent } from "./event/log.js";

/** Log an authenticated relay refusal without making an item, shout or verdict move [H2,H16]. */
export function recordRelayRefusal(board, { by, sequence, kind, operation, actor, code, itemId = null, person = null }) {
  logEvent(board, by, 'relay_refused', itemId, { sequence, kind, operation, actor, code, ...(person ? { person } : {}) }); // who tried it, from engine 73 [E3]
}
