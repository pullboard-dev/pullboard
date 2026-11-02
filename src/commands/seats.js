/** Report local command timing and the current activity of each seat [C7,N2]. */
import { context } from '../cli.js';
import { withBoardRead } from '../cli.js';
import { listAgents } from '../../packages/store/index.js';
import { listItems } from '../../packages/store/index.js';
import { readSeatTiming } from '../seat-ledger.js';
import { seatLedger } from '../seat-ledger.js';
import { seatLines } from '../seat-ledger.js';
import { worktreeActivity } from '../seat-ledger.js';

export function run(io) {
  const ctx = context(io);
  const snapshot = withBoardRead(ctx, board => {
    const events = board.db.prepare("SELECT event_at,event_by,event_kind,item_id,event_detail FROM event WHERE event_at >= ? ORDER BY event_id").all(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    return { agents: listAgents(board), items: listItems(board, { all: true }), events };
  });
  const holders = new Set(snapshot.items.filter(item => item.item_status === 'claimed').map(item => item.item_owner));
  const activity = new Map(snapshot.agents.filter(agent => holders.has(agent.agent_id)).map(agent => [agent.agent_id, worktreeActivity(agent.agent_path)]));
  const rows = seatLedger(snapshot.agents, snapshot.items, snapshot.events, readSeatTiming(ctx.info.commonDir), Date.now(), activity);
  io.result?.({ seats: rows });
  for (const line of seatLines(rows)) io.say(line);
  return 0;
}
