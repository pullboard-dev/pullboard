/**
 * The clock health document: the invariant "items without owner+deadline = 0", computed from the same table and facts the
 * clock pass uses. Read-only; the pass stores the document in board meta so status and the watch read one stored value
 * and never import the table [B4,C7].
 */
import { clockRow } from '../../logic/clock/table.js';
import { boardFacts } from './facts.js';
import { timing } from './facts.js';

/** The version of the stored health document. */
export const CLOCK_HEALTH_VERSION = 1;
/** The board meta key the clock pass stores the document under. */
export const CLOCK_HEALTH_KEY = 'clock.health';

const MINUTE_MS = 60_000;

/** Whether a table row names an owner and a deadline (its own, or the lease, hold or root it inherits). */
function rowComplete(row) {
  return Boolean(row.owner) && (row.deadlineMinutes != null || Boolean(row.deadlineFrom));
}

/**
 * Compute the clock health of every open, claimed or submitted item at now. An item is without owner+deadline when the
 * table has no row for its facts, or its row has no owner or no deadline. Overdue counts items past their deadline.
 *
 * @param {object} board - An open board.
 * @param {{ now: number | Date, ports: { listItems: Function, events: Function, getItem: Function }, facts?: (board: object, item: object) => object }} options
 * @returns {{ version: number, at: string, withoutOwnerDeadline: number, withoutOwnerDeadlineIds: number[], overdue: number, oldestOverdueMinutes: number, byRule: object }}
 */
export function clockHealth(board, { now, ports, facts } = {}) {
  const at = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(at)) throw new Error('clockHealth: now must be a time in ms or a Date');
  const missing = [];
  const byRule = {};
  let overdue = 0;
  let oldest = 0;
  for (const item of ports.listItems(board)) {
    if (!['open', 'claimed', 'submitted'].includes(item.item_status)) continue;
    let row;
    try { row = clockRow({ ...boardFacts(board, item, ports.getItem), ...(facts ? facts(board, item) : {}) }); }
    catch { missing.push(item.item_id); continue; }
    if (!rowComplete(row)) { missing.push(item.item_id); continue; }
    const { since, deadlineMinutes } = timing(item, row, ports.events(board, { itemId: item.item_id }));
    const minutes = deadlineMinutes ?? row.deadlineMinutes;
    const deadlineAt = since !== null && minutes > 0 ? since + minutes * MINUTE_MS : null;
    const entry = byRule[row.rule] ??= { count: 0, nextDeadlineAt: null, move: row.move };
    entry.count += 1;
    if (deadlineAt === null) continue;
    if (entry.nextDeadlineAt === null || deadlineAt < entry.nextDeadlineAt) entry.nextDeadlineAt = deadlineAt;
    if (deadlineAt <= at) {
      overdue += 1;
      oldest = Math.max(oldest, Math.floor((at - deadlineAt) / MINUTE_MS));
    }
  }
  return { version: CLOCK_HEALTH_VERSION, at: new Date(at).toISOString(), withoutOwnerDeadline: missing.length, withoutOwnerDeadlineIds: missing,
    overdue, oldestOverdueMinutes: oldest, byRule };
}
