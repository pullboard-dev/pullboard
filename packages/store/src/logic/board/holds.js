/** Same-item recorded-event hold conditions, evaluated inside the native write transaction [B4,H16]. */
import { Refused } from "../../../../kernel/light.js";
import { STALE_STATE_ENGINE } from "../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
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

/** Clear bounded per-hold maintenance metadata whenever its native hold is lifted. */
export function forgetHoldMaintenance(board, id) {
  rememberHoldCondition(board, id, null);
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
