/** The pullboard log command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  agentDisplayName,
  context,
  idArg,
  withBoardRead,
} from '../entry.js';

/** Run `pullboard log` and return its exit code. */
export function run(io, { first, values = {} }) {
  const ctx = context(io);
  const itemId = first ? idArg(first) : undefined;
  let since;
  if (values.since !== undefined) {
    const at = new Date(values.since);
    if (Number.isNaN(at.getTime())) throw new Refused('USAGE', `pullboard log --since takes an ISO time, not "${values.since}"`, 'pullboard log --since 2026-11-01T00:00:00Z');
    since = at.toISOString();
  }
  const kinds = values.kind === undefined ? undefined : String(values.kind).split(',').map(kind => kind.trim()).filter(Boolean);
  const { rows, agents } = withBoardRead(ctx, (board) => ({ rows: store.events(board, { itemId, since, kinds }), agents: store.listAgents(board) }));
  // Rows go out one at a time: a large board's log is more than one string (or one budgeted reply) can hold.
  const write = io.stdout?.write && !values.json ? (text) => io.stdout.write(`${text}\n`) : (text) => io.say(text);
  // A filtered --json read is NDJSON, one event per line, written straight to stdout; the unfiltered document keeps its { events } shape.
  if (values.json && (since !== undefined || kinds !== undefined)) {
    for (const event of rows) (io.stdout?.write ? (text) => io.stdout.write(`${text}\n`) : (text) => io.say(text))(JSON.stringify(event));
    return 0;
  }
  io.result?.({ events: rows });
  rows.forEach((event) => write(`${event.event_at.slice(0, 19)}  ${agentDisplayName(agents, ctx.config, event.event_by).padEnd(24)} ${event.event_kind.padEnd(9)} ${event.item_id ? `#${event.item_id}` : ''} ${event.event_detail === '{}' ? '' : event.event_detail}`.trimEnd()));
  return 0;
}
