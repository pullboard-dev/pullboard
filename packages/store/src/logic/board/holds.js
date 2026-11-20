/** Same-item recorded-event hold conditions, evaluated inside the native write transaction [B4,H16]. */
import { Refused } from "../../../../kernel/light.js";
import { STALE_STATE_ENGINE } from "../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { writeBoardMeta } from "../../io/board/meta.js";
import { readBoardMeta } from "../../io/board/meta.js";
import { deleteBoardMeta } from "../../io/board/meta.js";
import { staleInstant } from "./stale/state/policy.js";

const ALIASES = Object.freeze({ verified: 'accept', landed: 'merged' });
const KINDS = new Set(['claim', 'submit', 'accept', 'reject', 'reopen', 'merged', 'release', 'refreeze', 'withdraw', 'shout', 'proof-run']);

/** Accept named native events only; display aliases never become reason-text or cross-item inference. */
export function holdUntilKind(value) {
  if (value === undefined || value === null) return null;
  const kind = Object.hasOwn(ALIASES, value) ? ALIASES[value] : value;
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new Refused('USAGE', '--until names a native event on this same item, such as verified or landed');
  }
  return kind;
}

/** Replace one current condition per hold, rather than accumulating historical control keys. */
export function rememberHoldCondition(board, id, condition) {
  const key = `stale_hold_until:${id}`;
  if (condition === null) board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(key);
  else board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(key, JSON.stringify(condition));
}

/** Record who answers for a hold and when it lapses, one current record per hold [C7,#8539]. */
export function rememberHoldOwner(board, id, record) {
  writeBoardMeta(board.db, `hold_owner:${id}`, JSON.stringify(record));
}

/** The owner and deadline recorded for a hold, or null when it was held without them [C7,#8539]. */
export function itemHoldOwner(board, id) {
  const value = readBoardMeta(board.db, `hold_owner:${id}`);
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Clear bounded per-hold maintenance metadata whenever its native hold is lifted. */
export function forgetHoldMaintenance(board, id) {
  rememberHoldCondition(board, id, null);
  deleteBoardMeta(board.db, `hold_owner:${id}`);
  board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(`stale_hold_warning:${id}`);
}

/** Lift once at the first qualifying event after this exact hold; replay reads only native evidence. */
export function liftConditionalHold(board, event, logEvent, setItem) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < STALE_STATE_ENGINE || event.item_id === null) return;
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`stale_hold_until:${event.item_id}`);
  if (!row) return;
  let condition;
  try { condition = JSON.parse(row.meta_value); } catch { return; }
  if (condition.kind !== event.event_kind || !Number.isSafeInteger(condition.holdEventId) || condition.holdEventId >= event.event_id) return;
  const item = board.db.prepare('SELECT item_hold_at,item_hold_reason,item_hold_by FROM item WHERE item_id=?').get(event.item_id);
  const now = board.clock.now().getTime();
  const heldAt = staleInstant(condition.heldAt, now);
  const eventAt = staleInstant(event.event_at, now);
  if (heldAt === null || eventAt === null || eventAt < heldAt) return;
  if (!item || item.item_hold_by !== 'coordinator' || item.item_hold_at !== condition.heldAt || !item.item_hold_reason) return;
  // Delete first: the resulting native unhold cannot recursively satisfy this condition again.
  forgetHoldMaintenance(board, event.item_id);
  setItem(board, event.item_id, { item_hold_reason: null, item_hold_by: null, item_hold_at: null }, event.event_at);
  logEvent(board, 'coordinator', 'unhold_item', event.item_id, { reason: item.item_hold_reason,
    until: condition.kind, holdEventId: condition.holdEventId, triggerEventId: event.event_id });
}

const DONE = new Set(['landed', 'withdrawn']);

/** True when every item a hold reason names has landed or been withdrawn; a reason naming none is never settled [C7]. Pure: no board writes. */
export function settledHoldReason(reason, statusOf) {
  const ids = [...new Set(String(reason ?? '').match(/#\d+/g) ?? [])];
  return ids.length > 0 && ids.every(id => DONE.has(statusOf(id.slice(1))));
}

const REBAR = 're-bar:';

/**
 * The re-bar text for a hold whose reason names at least one withdrawn item and only landed or withdrawn items, keeping the original text; null otherwise.
 * Why: a withdrawn dependency did not deliver its work, so the held item needs a fresh bar rather than a silent lift [C7].
 * @param {string|null} reason the hold reason
 * @param {(id: string) => string|undefined} statusOf the settled status of an item id
 * @returns {string|null}
 */
export function rebarHoldReason(reason, statusOf) {
  const text = String(reason ?? '');
  const statuses = [...new Set(text.match(/#\d+/g) ?? [])].map(id => statusOf(id.slice(1)));
  if (statuses.length === 0 || !statuses.every(status => DONE.has(status)) || !statuses.includes('withdrawn')) return null;
  return text.startsWith(REBAR) ? text : `${REBAR} ${text}`;
}

/** True when a parent has at least one child and every child has landed or been withdrawn [C7]. */
export function parentHoldSettled(childStatuses) {
  return childStatuses.length > 0 && childStatuses.every(status => DONE.has(status));
}

/** How the board names an item's state for the settled rules: landed (merged), withdrawn, or its own status. */
function settledStatus(row) {
  return row?.item_merged_commit ? 'landed' : row?.item_status;
}

/**
 * With holds.liftSettled on, lift a hold whose reason names only landed or withdrawn items, or a parent hold whose children
 * are all done, on the board write that records main moving, an item landing or an item withdrawn. A hold naming a withdrawn item is rewritten to re-bar text on a withdraw event instead. An automatic released-twice hold is left to its own lift.
 * Why: a hold waits for work that may already be done, and nobody was told to look again (#2962).
 *
 * @param {object} board the open board; `board.liftSettledHolds` is the setting, off unless true
 * @param {object} event the event just written
 * @param {Function} logEvent writes an event
 * @param {Function} setItem patches an item
 */
export function liftSettledHolds(board, event, logEvent, setItem) {
  if (board.liftSettledHolds !== true || !['main-moved', 'merged', 'withdraw'].includes(event.event_kind)) return;
  const find = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?');
  const kids = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_parent_id=?');
  const held = board.db.prepare(`SELECT item_id,item_hold_reason FROM item WHERE item_hold_reason IS NOT NULL AND item_hold_reason NOT LIKE 'Released twice%' AND item_hold_reason NOT LIKE 're-bar:%'`).all();
  for (const item of held) {
    if (item.item_id === event.item_id) continue;
    const rebar = event.event_kind === 'withdraw' ? rebarHoldReason(item.item_hold_reason, id => settledStatus(find.get(Number(id)))) : null;
    if (rebar !== null) {
      setItem(board, item.item_id, { item_hold_reason: rebar }, event.event_at);
      logEvent(board, 'coordinator', 'hold_item', item.item_id, { reason: rebar, cause: 'withdrawn-dependency', triggerEventId: event.event_id });
      continue;
    }
    const settled = settledHoldReason(item.item_hold_reason, id => settledStatus(find.get(Number(id))))
      || parentHoldSettled(kids.all(item.item_id).map(settledStatus));
    if (!settled) continue;
    forgetHoldMaintenance(board, item.item_id);
    setItem(board, item.item_id, { item_hold_reason: null, item_hold_by: null, item_hold_at: null }, event.event_at);
    logEvent(board, 'coordinator', 'unhold_item', item.item_id, { reason: item.item_hold_reason, cause: 'settled', triggerEventId: event.event_id });
  }
}
