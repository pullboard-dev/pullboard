/** Report local command timing and the current activity of each seat [C7,N2]. */
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';
import { listAgents } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { readSeatTiming } from '../../../../../packages/seats/index.js';
import { seatLedger } from '../../../../../packages/seats/index.js';
import { seatLines } from '../../../../../packages/seats/index.js';
import { worktreeActivity } from '../../../../../packages/seats/index.js';
import { commandTimingReport } from '../../logic/timing.js';
import { commandTimingLines } from '../../logic/timing.js';

/**
 * Report local command timing and the current activity of each seat.
 *
 * @param {object} io
 * @returns {number}
 */
export function run(io) {
  const ctx = context(io);
  const snapshot = withBoardRead(ctx, board => {
    const events = board.db.prepare("SELECT event_at,event_by,event_kind,item_id,event_detail FROM event WHERE event_at >= ? ORDER BY event_id").all(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    return { agents: listAgents(board), items: listItems(board, { all: true }), events };
  });
  const holders = new Set(snapshot.items.filter(item => item.item_status === 'claimed').map(item => item.item_owner));
  const activity = new Map(snapshot.agents.filter(agent => holders.has(agent.agent_id)).map(agent => [agent.agent_id, worktreeActivity(agent.agent_path)]));
  const records = readSeatTiming(ctx.info.commonDir);
  const rows = seatLedger(snapshot.agents, snapshot.items, snapshot.events, records, Date.now(), activity);
  // The last day of command rows: the same window the seat states use.
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const timing = commandTimingReport(records.filter(row => row.start >= since));
  io.result?.({ seats: rows, timing });
  for (const line of seatLines(rows)) io.say(line);
  for (const line of commandTimingLines(timing)) io.say(line);
  return 0;
}
