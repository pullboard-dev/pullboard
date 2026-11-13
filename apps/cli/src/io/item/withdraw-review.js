/** The optional withdraw.review step: a withdrawal waits as a note until a second seat confirms it [C7]. */
const PENDING = 'Withdrawal pending: ';
const REJECTED = 'Withdrawal rejected: ';

/**
 * The withdrawal an item is waiting on, or null: its latest pending note that no rejection or later withdrawal followed.
 * Why: the pending state lives in the item's own thread, so no new item state or board move is needed.
 *
 * @param {object} board - The open board.
 * @param {number} id - The item id.
 * @returns {{ by: string, reason: string } | null}
 */
export function pendingWithdrawal(board, id) {
  let pending = null;
  const rows = board.db.prepare("SELECT event_by AS by, event_detail AS detail FROM event WHERE item_id = ? AND event_kind = 'fact' ORDER BY event_id").all(id);
  for (const row of rows) {
    const text = String(JSON.parse(row.detail)?.text ?? '');
    if (text.startsWith(PENDING)) pending = { by: row.by, reason: text.slice(PENDING.length) };
    else if (text.startsWith(REJECTED)) pending = null;
  }
  return pending;
}

/** The fact text that records a pending withdrawal. */
export const pendingText = (reason) => `${PENDING}${reason}`;

/** The fact text that records a rejected withdrawal. */
export const rejectedText = (reason) => `${REJECTED}${reason}`;
