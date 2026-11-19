/** A seat's returned rejections and the one line that echoes each to its builder [C7,#2220]. */

/**
 * The open items this seat built whose latest verdict is REJECT, in the order given.
 * Why: a reject reopens the item unowned, so the builder finds its returned work by status, verdict and builder, not by owner [C7,#2220].
 * @param {{ item_status: string, item_verdict?: string | null, item_built_by?: string | null }[]} items
 * @param {string} agentId
 * @returns {object[]}
 */
export function returnedRejections(items, agentId) {
  return items.filter(item => item.item_status === 'open' && item.item_verdict === 'REJECT' && item.item_built_by === agentId);
}

/**
 * One line naming the item, the reason, the clause when a verifier named one, and the verdict note.
 * Why: a rejection that arrives as one line is read by the builder at once, with no show call to find the gap [C7,#2220].
 * @param {{ id: number, title?: string, reason?: string, clause?: string | number | null, note?: string }} rejection
 * @returns {string}
 */
export function rejectionEchoLine({ id, title, reason, clause, note }) {
  const text = String(note ?? '').replace(/\s+/gu, ' ').trim();
  const named = clause === undefined || clause === null || clause === '' ? '' : `, clause ${String(clause).replace(/^clause\s+/iu, '')}`;
  return `rejected #${id}${title ? ` ${title}` : ''}: ${reason ?? 'REJECT'}${named}${text ? `: ${text}` : ''}`;
}
