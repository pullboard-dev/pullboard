/** A real SQLite board with a coordinator and one builder seat, for inbox entries that stay until acted on [C7,#8519]. */
// fixture-subject: addItem
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';

/** The board with inbox.keepUntilActed on (and `escalate(interval, minutesLater)` sweeping aged entries), the builder seat, and helpers that shout it a kind, read its entries and act on one. */
export function entryBoard(t) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const seat = store.register(board, { lane: 'core', path: '/seat', route: 'strong' });
  board.inboxKeep = true;
  /** The coordinator shouts the seat with a kind. */
  const shout = (kind, text) => store.shout(board, { from: 'coordinator', to: seat, text, lanes: ['core'], kind });
  /** Read the inbox the way a seat does, consuming its unread cursor, so a kept entry is shown to outlive the read. */
  const read = () => store.inbox(board, seat);
  return { board, seat, shout, read, entries: () => store.openEntries(board, seat), escalate: (minutes, laterMinutes) => store.escalateEntries(board, { minutes, nowMs: Date.now() + laterMinutes * 60_000, coordinator: 'coordinator' }),
    act: (id, action) => store.recordEntryAction(board, seat, id, action) };
}
