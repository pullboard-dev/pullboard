/** Report local command timing and the current activity of each seat [C7,N2]. */
import { context, withBoardRead } from '../cli.js';
import { listAgents, listItems } from '../../packages/store/index.js';
import { readSeatTiming, seatLedger, seatLines } from '../seat-ledger.js';

export function run(io) {
  const ctx = context(io);
  const rows = withBoardRead(ctx, board => {
    const events = board.db.prepare("SELECT event_at,event_by,event_kind,item_id,event_detail FROM event WHERE event_at >= ? ORDER BY event_id").all(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    return seatLedger(listAgents(board), listItems(board, { all: true }), events, readSeatTiming(ctx.info.commonDir));
  });
  io.result?.({ seats: rows });
  for (const line of seatLines(rows)) io.say(line);
  return 0;
}
