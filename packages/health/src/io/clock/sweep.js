/**
 * The clock pass: one sweeper reads every non-terminal item once, asks the clock table for its row and whether the row's
 * default move is due, and applies each due move that has a registered function, logging it as one clock_move event by
 * the board [B4,C7]. Moves with no registered function are reported as pending and never applied; their own slices
 * register them. One move per item per pass, and a second pass at the same now applies nothing new.
 */
import { clockRow } from '../../logic/clock/table.js';
import { clockDue } from '../../logic/clock/table.js';
import { boardFacts } from './facts.js';
import { timing } from './facts.js';
import { CLOCK_MOVE_EVENT } from './facts.js';
import { CLOCK_ACTOR } from './facts.js';
import { clockHealth } from './health.js';
import { CLOCK_HEALTH_KEY } from './health.js';
/** The version of the result document `pullboard clock --json` prints. */
export const CLOCK_SWEEP_VERSION = 1;

export { CLOCK_MOVE_EVENT };

const MINUTE_MS = 60_000;
/** The store moves clockSweep needs, passed as ports. */
const PORTS = Object.freeze(['listItems', 'events', 'getItem', 'atomic', 'logEvent', 'insertShout', 'readBoardMeta', 'writeBoardMeta']);

/** Parse an event detail without letting one malformed legacy row stop the pass. */
function detailOf(event) {
  try { return JSON.parse(event.event_detail ?? '{}') ?? {}; }
  catch { return {}; }
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

/** Whether a clock_move for this rule and state start is already on the item, which makes the pass idempotent. */
function alreadyApplied(history, rule, since) {
  return history.some(event => event.event_kind === CLOCK_MOVE_EVENT && event.event_by === CLOCK_ACTOR
    && detailOf(event).rule === rule && detailOf(event).since === since);
}

/**
 * Compute the clock health, and unless this is a dry run store it in board meta (key clock.health) and shout the
 * coordinator once per item that newly lacks an owner or deadline: an id already in the stored document is not shouted again.
 *
 * @returns {object} The health document.
 */
function storeHealth(board, { at, dryRun, facts, ports }) {
  const health = clockHealth(board, { now: at, facts, ports });
  if (dryRun) return health;
  let previous = [];
  try { previous = JSON.parse(ports.readBoardMeta(board.db, CLOCK_HEALTH_KEY) ?? '{}').withoutOwnerDeadlineIds ?? []; }
  catch { previous = []; }
  ports.atomic(board, () => {
    for (const id of health.withoutOwnerDeadlineIds.filter(each => !previous.includes(each))) {
      ports.insertShout(board, { from: 'sentinel', to: ports.coordinator, lanes: [], item: id, detail: { kind: 'clock', rule: 'no-owner-deadline' },
        text: `#${id} has no owner or deadline in the clock table; the clock cannot move it.` });
    }
    ports.writeBoardMeta(board.db, CLOCK_HEALTH_KEY, JSON.stringify(health));
  });
  return health;
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
    let row;
    // An item no row covers has no move to make; the health document names it and the alarm shouts it.
    try { row = clockRow({ ...boardFacts(board, item, getItem), ...(facts ? facts(board, item) : {}) }); }
    catch { continue; }
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
  result.health = storeHealth(board, { at, dryRun: result.dryRun, facts, ports });
  return result;
}
