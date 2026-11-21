/**
 * The clock pass: one sweeper reads every non-terminal item once, asks the clock table for its row and whether the row's
 * default move is due, and applies each due move that has a registered function, logging it as one clock_move event by
 * the board [B4,C7]. Moves with no registered function are reported as pending and never applied; their own slices
 * register them. One move per item per pass, and a second pass at the same now applies nothing new.
 */
import { clockRow } from '../../logic/clock/table.js';
import { clockDue } from '../../logic/clock/table.js';
/** The version of the result document `pullboard clock --json` prints. */
export const CLOCK_SWEEP_VERSION = 1;

/** The event kind each applied move is logged as, and the actor that logs it. */
export const CLOCK_MOVE_EVENT = 'clock_move';
const CLOCK_ACTOR = 'board';

const MINUTE_MS = 60_000;
/** The store moves clockSweep needs, passed as ports. */
const PORTS = Object.freeze(['listItems', 'events', 'getItem', 'atomic', 'logEvent', 'insertShout']);
/** Events that are the clock's own output, so they never count as the item's progress. */
const CLOCK_OWN_KINDS = new Set([CLOCK_MOVE_EVENT, 'shout']);
const CLOCK_OWN_ACTORS = new Set([CLOCK_ACTOR, 'sentinel']);

/** Parse an event detail without letting one malformed legacy row stop the pass. */
function detailOf(event) {
  try { return JSON.parse(event.event_detail ?? '{}') ?? {}; }
  catch { return {}; }
}

/** A board time (ISO text or ms) as ms, or null. */
function ms(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The alarm move: one coordinator shout per item per deadline, under the board writer lock with its clock_move event.
 *
 * @returns {object} What the move did, kept in the event's evidence.
 */
function alarm(board, item, row, _now, plan, ports) {
  const text = `#${item.item_id} has sat in "${row.state}" past its ${row.rule} deadline (${new Date(plan.deadlineAt).toISOString()}); owner: ${row.owner}.`;
  ports.insertShout(board, { from: 'sentinel', to: ports.coordinator, text, lanes: [], item: item.item_id,
    detail: { kind: 'clock', rule: row.rule, since: plan.since, deadlineAt: plan.deadlineAt } });
  return { shout: ports.coordinator };
}

/** The existing move: the item's existing path (the gate or review lease) owns it, so the clock only records the deadline. */
function existing() {
  return { owner: 'existing-path' };
}

/** The move registry: a move name to function(board, item, row, now, plan, ports). This slice registers alarm and existing only. */
export const CLOCK_MOVES = new Map([
  ['alarm', alarm],
  ['existing', existing],
]);

/**
 * One item's clock facts, read from the board: its status, hold, review and whether every after has landed.
 * Gate facts (deferred or unknown) come through ports.facts until their slice reads them from the job table.
 */
function boardFacts(board, item, getItem) {
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
function timing(item, row, history) {
  const progress = history.filter(event => !CLOCK_OWN_KINDS.has(event.event_kind) && !CLOCK_OWN_ACTORS.has(event.event_by)
    && (item.item_status !== 'claimed' || event.event_by === item.item_owner || event.event_kind === 'claim'));
  let since = ms(progress.at(-1)?.event_at) ?? ms(item.item_updated_at) ?? ms(item.item_created_at);
  if (row.rule === 'hold') since = ms(item.item_hold_at) ?? since;
  // Open and unclaimed is observed directly, so a ready item is idle; folder and seat activity is not visible here.
  const evidence = row.rule === 'ready' ? 'idle' : 'unknown';
  let deadlineMinutes;
  if (row.rule === 'review') {
    const until = ms(item.item_review_until);
    if (until !== null && since !== null && until > since) deadlineMinutes = (until - since) / MINUTE_MS;
  }
  return { since, evidence, deadlineMinutes };
}

/** Whether a clock_move for this rule and state start is already on the item, which makes the pass idempotent. */
function alreadyApplied(history, rule, since) {
  return history.some(event => event.event_kind === CLOCK_MOVE_EVENT && event.event_by === CLOCK_ACTOR
    && detailOf(event).rule === rule && detailOf(event).since === since);
}

/**
 * Run one clock pass. Every due item gets at most one move; dry-run returns the same lists and writes nothing.
 *
 * The board moves arrive as ports (the store's listItems, events, getItem, atomic, logEvent and insertShout, and the
 * coordinator's id) so this cell imports no store or config door; the CLI command and the test pass them.
 *
 * @param {object} board - An open board.
 * @param {{ now: number | Date, dryRun?: boolean, moves?: Map<string, Function>, facts?: (board: object, item: object) => object, ports: object }} options
 * @returns {{ version: number, at: string, dryRun: boolean, applied: object[], pending: object[], waiting: object[] }}
 */
export function clockSweep(board, { now, dryRun = false, moves = CLOCK_MOVES, facts, ports } = {}) {
  for (const name of PORTS) if (typeof ports?.[name] !== 'function') throw new Error(`clockSweep: ports.${name} must be the store's ${name}`);
  if (typeof ports.coordinator !== 'string' || !ports.coordinator) throw new Error('clockSweep: ports.coordinator must name the coordinator');
  const { listItems, events, getItem, atomic, logEvent } = ports;
  const at = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(at)) throw new Error('clockSweep: now must be a time in ms or a Date');
  const result = { version: CLOCK_SWEEP_VERSION, at: new Date(at).toISOString(), dryRun: dryRun === true, applied: [], pending: [], waiting: [] };
  for (const item of listItems(board)) {
    if (!['open', 'claimed', 'submitted'].includes(item.item_status)) continue;
    const row = clockRow({ ...boardFacts(board, item, getItem), ...(facts ? facts(board, item) : {}) });
    const history = events(board, { itemId: item.item_id });
    const { since, evidence, deadlineMinutes } = timing(item, row, history);
    const base = { item: item.item_id, rule: row.rule, state: row.state, move: row.move, since, evidence };
    if (since === null || !(deadlineMinutes ?? row.deadlineMinutes)) {
      result.waiting.push({ ...base, reason: 'deadline-unknown' });
      continue;
    }
    const minutes = deadlineMinutes ?? row.deadlineMinutes;
    const verdict = clockDue({ rule: row.rule, since, evidence, deadlineMinutes: minutes }, at);
    if (!verdict.due) {
      result.waiting.push({ ...base, reason: verdict.waiting ?? 'not-due', deadlineAt: verdict.deadlineAt });
      continue;
    }
    const plan = { ...base, deadlineAt: since + minutes * MINUTE_MS, unknownWaited: evidence === 'unknown' };
    const apply = moves.get(row.move);
    if (!apply) { result.pending.push(plan); continue; }
    if (alreadyApplied(history, row.rule, since)) { result.waiting.push({ ...base, reason: 'already-applied', deadlineAt: plan.deadlineAt }); continue; }
    if (!dryRun) {
      atomic(board, () => {
        const outcome = apply(board, item, row, at, plan, ports) ?? {};
        logEvent(board, CLOCK_ACTOR, CLOCK_MOVE_EVENT, item.item_id, { rule: row.rule, state: row.state, move: row.move, since,
          deadlineAt: plan.deadlineAt, evidence: { kind: evidence, ...outcome }, unknownWaited: plan.unknownWaited });
      });
    }
    result.applied.push(plan);
  }
  return result;
}
