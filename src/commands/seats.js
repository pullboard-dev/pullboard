/** Report local command timing and the current activity of each seat [C7,N2]. */
import { context, withBoardRead } from '../cli.js';
import { listAgents, listItems } from '../../packages/store/index.js';
import { readSeatTiming, seatLedger } from '../seat-ledger.js';

export function run(io) {
  const ctx = context(io);
  const rows = withBoardRead(ctx, board => {
    const events = board.db.prepare("SELECT event_at,event_by,event_kind,item_id FROM event WHERE event_at >= ? ORDER BY event_id").all(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    return seatLedger(listAgents(board), listItems(board, { all: true }), events, readSeatTiming(ctx.info.commonDir));
  });
  io.result?.({ seats: rows });
  for (const row of rows) io.say(`${row.seat}: ${row.state}${row.item ? ` #${row.item}` : ''} for ${row.minutes}m; last 24h command ${(row.split.commandMs / 60000).toFixed(1)}m, tests ${(row.split.testMs / 60000).toFixed(1)}m, runner wait ${(row.split.runnerWaitMs / 60000).toFixed(1)}m, landed ${row.landed}`);
  return 0;
}
