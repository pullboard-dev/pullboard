/** The hold row's default move: a hold past its hard limit goes to the re-bar queue, whatever the evidence [B4,C7]. */

/** The prefix the store already gives a re-bar hold reason (packages/store/src/logic/board/holds.js). */
const REBAR = 're-bar:';
const DAY_MS = 86_400_000;
/** The owner a held item has once it sits in the re-bar queue, which the coordinator lane works. */
export const REBAR_QUEUE_OWNER = 're-bar-queue';
/** The ports the move needs on top of the sweeper's own. */
const MOVE_PORTS = Object.freeze(['setItem', 'rememberHoldOwner']);

/**
 * The to-rebar move: rewrite the hold reason with the re-bar prefix keeping the original text, make the re-bar queue
 * the owner with a fresh deadline a day out, and leave the item held. Nothing is lifted or deleted.
 *
 * @returns {object} What the move did, kept in the clock_move event's evidence.
 */
export function toRebar(board, item, _row, now, _plan, ports) {
  for (const name of MOVE_PORTS) if (typeof ports?.[name] !== 'function') throw new Error(`to-rebar: ports.${name} must be the store's ${name}`);
  const text = String(item.item_hold_reason ?? '');
  const reason = text.startsWith(REBAR) ? text : `${REBAR} ${text}`;
  const deadline = new Date(now + DAY_MS).toISOString();
  ports.setItem(board, item.item_id, { item_hold_reason: reason }, new Date(now).toISOString());
  ports.rememberHoldOwner(board, item.item_id, { owner: REBAR_QUEUE_OWNER, deadline });
  return { owner: REBAR_QUEUE_OWNER, deadline, reason };
}

/**
 * The minutes from the hold event to its recorded deadline, or undefined when the hold has none (the table's 1440 applies).
 * Reads the store's recorded hold owner through the optional itemHoldOwner port.
 */
export function recordedHoldMinutes(board, item, since, ports) {
  const record = typeof ports?.itemHoldOwner === 'function' ? ports.itemHoldOwner(board, item.item_id) : null;
  const at = Date.parse(record?.deadline ?? '');
  return Number.isFinite(at) && since !== null && at > since ? (at - since) / 60_000 : undefined;
}
