/** Shared item-message addressing for the board's inbox, resume and live watch [B7,N19,A2]. */
import { Refused } from './refused.js';

/** Reserved engine-93 address: '+' is forbidden in lane names and their derived seat ids. */
export const COORDINATION_SHOUT = 'coordinator+person';

/** Validate an explicit item address against this board before writing its message. */
export function itemShoutTarget(db, value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Refused('BAD_SHOUT_ITEM', 'an item message needs an existing positive item id; run pullboard shout --item <id> "text"');
  if (!db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(value)) throw new Refused('NO_ITEM', `no item #${value}; run pullboard list, then address an existing item`);
  return `item:${value}`;
}

/** Decode only the canonical item address; ordinary seats and lanes keep their old names. */
export function shoutItemId(to) {
  const match = /^item:([1-9]\d*)$/u.exec(String(to));
  const id = match ? Number(match[1]) : null;
  return Number.isSafeInteger(id) ? id : null;
}

/** Whether a seat currently builds or reviews this item, or coordinates its work. */
export function itemShoutReader(db, id, agent) {
  const item = db.prepare('SELECT item_owner, item_built_by, item_review_by, item_verified_by FROM item WHERE item_id = ?').get(id);
  return Boolean(item && (agent === 'coordinator' || (item.item_owner ?? item.item_built_by) === agent
    || (item.item_review_by ?? item.item_verified_by) === agent
    || db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind IN ('handoff-open','handoff-take') AND event_by=? LIMIT 1").get(id, agent)));
}

/** Match one live shout against an explicit seat or lane audience, including its item roles. */
export function shoutMatchesAudience(db, to, audience) {
  if (to === COORDINATION_SHOUT) return audience.has('coordinator') || audience.has('person');
  if (audience.has(to)) return true;
  const item = shoutItemId(to);
  if (item === null) return false;
  return [...audience].some((agent) => itemShoutReader(db, item, agent));
}

/**
 * The unread selection. Its item branch is a non-correlated IN list: SQLite evaluates the reader's item set once per
 * query, instead of running an event subquery for every item-addressed shout. A seat with a long backlog of such
 * shouts paid that subquery on every row, about a second on a 40,000-shout board (#1490). Positional bindings work on
 * the supported minimum Node SQLite API as well as newer releases.
 */
export const UNREAD_SHOUT_SQL = `FROM shout WHERE shout_id > ? AND shout_from != ? AND
  (shout_to IN ('all', ?, ?) OR (shout_to = '${COORDINATION_SHOUT}' AND ? IN ('coordinator', 'person')) OR shout_to IN (SELECT 'item:' || item_id FROM item WHERE
    (? = 'coordinator' OR COALESCE(item_owner, item_built_by) = ? OR COALESCE(item_review_by, item_verified_by) = ? OR EXISTS
      (SELECT 1 FROM event WHERE event.item_id=item.item_id AND event_kind IN ('handoff-open','handoff-take') AND event_by=?))))`;

/** Bind every positional identity occurrence explicitly, including item-role checks. */
export function unreadShoutBindings(cursor, seat, lane) {
  return [cursor, seat, lane, seat, seat, seat, seat, seat, seat];
}
