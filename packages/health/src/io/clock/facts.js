/**
 * One item's clock facts and timing, read from the board, shared by the clock pass and the clock health document [B4,C7].
 */

const MINUTE_MS = 60_000;

/** The event kind each applied move is logged as, and the actor that logs it. */
export const CLOCK_MOVE_EVENT = 'clock_move';
export const CLOCK_ACTOR = 'board';
/** Events that are the clock's own output, so they never count as the item's progress. */
const CLOCK_OWN_KINDS = new Set([CLOCK_MOVE_EVENT, 'shout']);
const CLOCK_OWN_ACTORS = new Set([CLOCK_ACTOR, 'sentinel']);

/** A board time (ISO text or ms) as ms, or null. */
export function ms(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One item's clock facts, read from the board: its status, hold, review and whether every after has landed.
 * Gate facts (deferred or unknown) come through ports.facts until their slice reads them from the job table.
 */
export function boardFacts(board, item, getItem) {
  const afters = String(item.item_after ?? '').split(',').filter(Boolean).map(Number).filter(Number.isInteger);
  const unlanded = afters.some(id => {
    try { return !['verified', 'withdrawn'].includes(getItem(board, id).item_status); }
    catch { return true; }
  });
  return {
    status: item.item_status,
    held: Boolean(item.item_hold_reason),
    review: item.item_status === 'submitted' && Boolean(item.item_review_by),
    after: unlanded ? 'unlanded' : 'landed',
  };
}

/**
 * When the item's state (or its last progress) began, the evidence the board can see for it, and the deadline a row
 * inherits. Progress is any event on the item that is not the clock's own output; a claimed item counts only its holder's.
 */
export function timing(item, row, history) {
  const progress = history.filter(event => !CLOCK_OWN_KINDS.has(event.event_kind) && !CLOCK_OWN_ACTORS.has(event.event_by)
    && (item.item_status !== 'claimed' || event.event_by === item.item_owner || event.event_kind === 'claim'));
  let since = ms(progress.at(-1)?.event_at) ?? ms(item.item_updated_at) ?? ms(item.item_created_at);
  if (row.rule === 'hold') since = ms(item.item_hold_at) ?? since;
  // Open and unclaimed is observed directly, so a ready or re-scoped item is idle; folder and seat activity is not visible here.
  const evidence = ['ready', 'rescope'].includes(row.rule) ? 'idle' : 'unknown';
  let deadlineMinutes;
  if (row.rule === 'review') {
    const until = ms(item.item_review_until);
    if (until !== null && since !== null && until > since) deadlineMinutes = (until - since) / MINUTE_MS;
  }
  return { since, evidence, deadlineMinutes };
}

