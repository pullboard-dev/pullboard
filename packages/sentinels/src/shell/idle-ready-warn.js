/** Warn the coordinator once per idle spell when ready work waits beside a live seat that holds nothing [C7]. */
import { REVIEW_WAKE_WAIT_MS } from './review-capacity-wake.js';

/** A seat's idle spell: when it last acted on the board and the id of that action, which changes when it claims or leaves. */
function lastAction(board, seat) {
  const row = board.db.prepare('SELECT event_id, event_at FROM event WHERE event_by=? ORDER BY event_id DESC LIMIT 1').get(seat.agent_id);
  return { id: row?.event_id ?? 0, at: Date.parse(row?.event_at ?? seat.agent_created_at) };
}

/**
 * Tell the coordinator, once per idle spell, about each live seat that has held nothing past the wait while the
 * item its own `pullboard next` would give is open and ready. Why: 63 percent of filed-to-landed time was spent
 * waiting for a first claim while seats sat idle (speed package 1, item 4).
 *
 * @param {{ config?: object }} ctx - The sentinel context.
 * @param {any} board - The open board.
 * @param {(ctx: object, board: any, operation: string, args: any[]) => Promise<any>} ordered - Ordered board writer.
 * @param {{ listAgents: Function, withLocalSeatPresence: Function, dispatchWork: Function }} ports - The board's seat list, local presence and dispatch selector, passed in by the caller.
 * @param {number} [waitMs] - How long a seat may hold nothing before it is reported.
 */
export async function warnIdleReady(ctx, board, ordered, ports, waitMs = REVIEW_WAKE_WAIT_MS) {
  const { listAgents, withLocalSeatPresence, dispatchWork } = ports;
  const now = board.clock.now().getTime();
  for (const seat of withLocalSeatPresence(board, listAgents(board))) {
    if (seat.agent_id === 'coordinator' || seat.presence !== 'live') continue;
    const selected = dispatchWork(board, seat, { policy: ctx.config?.verify?.policy, familyPolicy: ctx.config?.verify?.family });
    if (selected.held || selected.review || selected.item?.item_status !== 'open') continue;
    const action = lastAction(board, seat);
    const idleMs = now - action.at;
    if (idleMs <= waitMs) continue;
    const marker = `[idle spell ${seat.agent_id}@${action.id}]`;
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_to=? AND instr(shout_text,?)>0').get('coordinator', marker)) continue;
    await ordered(ctx, board, 'shout', [{ from: 'sentinel', to: 'coordinator', lanes: [],
      text: `${seat.agent_id} has held nothing for ${Math.floor(idleMs / 60_000)} min while #${selected.item.item_id} is ready: pullboard next would give it that item ${marker}` }]);
  }
}
