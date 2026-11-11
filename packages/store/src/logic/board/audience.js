/** Shared item-message addressing for the board's inbox, resume and live watch [B7,N19,A2]. */
import { Refused } from "../../../../kernel/light.js";
import { shoutItemId } from "../../../../kernel/index.js";

/** Reserved engine-93 address: '+' is forbidden in lane names and their derived seat ids. */
export const COORDINATION_SHOUT = 'coordinator+person';

/** Validate an explicit item address against this board before writing its message. */
export function itemShoutTarget(db, value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Refused('BAD_SHOUT_ITEM', 'an item message needs an existing positive item id; run pullboard shout --item <id> "text"');
  if (!db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(value)) throw new Refused('NO_ITEM', `no item #${value}; run pullboard list, then address an existing item`);
  return `item:${value}`;
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
 * The unread selection splits direct, coordination and item targets into indexed branches. Why: combining these
 * audiences in one OR made SQLite scan every shout in a 40,000-message backlog. The item branch looks up only the item
 * each unread item shout names: building every item's role set first scanned 3,900 items and their events, 1.4 s of
 * every inbox and status on 9 Nov [C7]. Positional bindings work on the supported minimum Node SQLite API as well as newer releases.
 */
export const UNREAD_SHOUT_SQL = `FROM (
  SELECT * FROM shout WHERE shout_id > ? AND shout_from != ? AND shout_to IN ('all', ?, ?)
  UNION ALL
  SELECT * FROM shout WHERE shout_id > ? AND shout_from != ? AND shout_to = '${COORDINATION_SHOUT}' AND ? IN ('coordinator', 'person')
  UNION ALL
  SELECT * FROM shout WHERE shout_id > ? AND shout_from != ? AND shout_to >= 'item:' AND shout_to < 'item;' AND EXISTS
    (SELECT 1 FROM item WHERE item_id = CAST(substr(shout_to, 6) AS INTEGER) AND shout_to = 'item:' || item_id AND
    (? = 'coordinator' OR COALESCE(item_owner, item_built_by) = ? OR COALESCE(item_review_by, item_verified_by) = ? OR item.item_id IN
      (SELECT item_id FROM event WHERE event_kind IN ('handoff-open','handoff-take') AND event_by=? AND item_id IS NOT NULL)))
) AS unread`;

/** Bind every positional identity occurrence explicitly, including item-role checks. */
export function unreadShoutBindings(cursor, seat, lane) {
  return [cursor, seat, seat, lane, cursor, seat, seat, cursor, seat, seat, seat, seat, seat];
}

/** The kinds of evidence a shout can carry (B22): what was tried, or what was measured. */
export const EVIDENCE_KINDS = ['attempt', 'receipt'];

/**
 * Refuse evidence that is not fields a reader can trust (B22): its kind, its outcome, an item on
 * the board, and a full commit SHA, which the CLI resolves in the repo before it gets here.
 *
 * @param {any} board
 * @param {{ kind: string, outcome: string, item: number, commit: string }} evidence
 */
export function checkEvidence(board, { kind, outcome, item, commit }) {
  if (!EVIDENCE_KINDS.includes(kind)) throw new Refused('BAD_EVIDENCE', `the evidence kind is attempt or receipt, not "${kind ?? ''}": --evidence receipt`);
  if (!String(outcome ?? '').trim()) throw new Refused('BAD_EVIDENCE', 'evidence names its outcome: --outcome measured');
  if (!Number.isInteger(item) || !board.db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(item)) {
    throw new Refused('BAD_EVIDENCE', `evidence names an item on the board: --item <id> (saw ${item})`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Refused('BAD_EVIDENCE', `evidence names a commit by its full SHA (saw "${commit ?? ''}")`);
}
