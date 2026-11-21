/** The rescope row's default move: a re-scope release nobody cleared in time goes to the person's daily list [B4,C7]. */

/** The owner the person's daily list is read by (pullboard hold --list --owner person). */
export const PERSON_OWNER = 'person';
const DAY_MS = 86_400_000;
/** The ports the move needs on top of the sweeper's own. */
const MOVE_PORTS = Object.freeze(['holdItem']);

/**
 * The to-person move: hold the item with owner person and a deadline a day out. The reason quotes each re-scope release
 * (seat, reason code, text and age), as the store's re-scope listing words them. Nothing is deleted or decided: the
 * person's hold is never moved again by the clock (the sweeper leaves person-owned holds alone).
 *
 * @returns {object} What the move did, kept in the clock_move event's evidence.
 */
export function toPerson(board, item, _row, now, plan, ports) {
  for (const name of MOVE_PORTS) if (typeof ports?.[name] !== 'function') throw new Error(`to-person: ports.${name} must be the store's ${name}`);
  const releases = plan.rescopeReasons ?? [];
  const reason = `re-scope: nobody edited, refroze or rerouted it in time. ${releases.join('; ')}`;
  const deadline = new Date(now + DAY_MS).toISOString();
  ports.holdItem(board, item.item_id, { agentId: ports.coordinator, reason, owner: PERSON_OWNER, deadline });
  return { owner: PERSON_OWNER, deadline, reason };
}
