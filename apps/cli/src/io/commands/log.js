/** The pullboard log command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  agentDisplayName,
  context,
  idArg,
  withBoardRead,
} from '../entry.js';

/** Run `pullboard log` and return its exit code. */
export function run(io, { first }) {
  const ctx = context(io);
  const itemId = first ? idArg(first) : undefined;
  const { rows, agents } = withBoardRead(ctx, (board) => ({ rows: store.events(board, { itemId }), agents: store.listAgents(board) }));
  io.result?.({ events: rows });
  rows.forEach((event) => io.say(`${event.event_at.slice(0, 19)}  ${agentDisplayName(agents, ctx.config, event.event_by).padEnd(24)} ${event.event_kind.padEnd(9)} ${event.item_id ? `#${event.item_id}` : ''} ${event.event_detail === '{}' ? '' : event.event_detail}`.trimEnd()));
  return 0;
}
