/** A seat idling in `next --wait` hears its shouts on every retry, not only when it leaves [B3,N2]. */
import { getItem } from '../../../store/index.js';
import { inbox } from '../../../store/index.js';

/** A shout that asks the seat to act on a named item: an action word, then the item's #id. */
const ASK = /\b(?:review|verify|build|take|claim|fix|resubmit|land|work on|act on)\b[^#\n]{0,60}#(\d+)/iu;

/**
 * Read this seat's unread shouts once, mark them read, and name the item a shout asks it to act on.
 * Why: the idle wait used to show unread shouts only when it offered an item or gave up, so a seat
 * waiting for work never saw the coordinator's routing for 30 minutes. Reads first on a read-only
 * board, so a quiet retry never queues behind another seat's write.
 *
 * @param {any} ctx
 * @param {Set<number>} seen shout ids already printed in this wait; the coordinator's open requests stay unread
 * @param {{withBoard: Function, withBoardRead: Function, whoAmI: Function}} ports
 * @returns {{lines: string[], item: any}} the new lines, and the item to act on (or null)
 */
export function takeWaitShouts(ctx, seen, { withBoard, withBoardRead, whoAmI }) {
  const heard = withBoardRead(ctx, board => {
    const me = whoAmI(ctx, board);
    const fresh = inbox(board, me.id, { markRead: false }).filter(shout => !seen.has(shout.shout_id));
    return { me: me.id, fresh };
  });
  if (!heard.fresh.length) return { lines: [], item: null };
  const through = Math.max(...heard.fresh.map(shout => shout.shout_id));
  const item = withBoard(ctx, board => {
    inbox(board, heard.me, { through });
    for (const shout of heard.fresh) {
      const named = ASK.exec(shout.shout_text)?.[1];
      if (named === undefined) continue;
      try {
        const asked = getItem(board, Number(named));
        // A finished item asks nothing: an old backlog shout must not end the wait on landed work.
        if (!['verified', 'withdrawn'].includes(asked.item_status)) return asked;
      } catch { /* an unknown id asks nothing */ }
    }
    return null;
  });
  for (const shout of heard.fresh) seen.add(shout.shout_id);
  const lines = heard.fresh.map(shout => `${shout.shout_from} -> ${shout.shout_to}: ${shout.shout_text}`);
  return { lines, item };
}
