/** The release move table run over the live board: the store's release writer reads its decision from it [C7,#8246]. */
import { runReleaseTable } from "./landing/lease.js";

/** The event kinds the table's rules read, as the history reader of the replay reads them. */
const KINDS = Object.freeze(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'withdraw', 'merged', 'reopen', 'escalate', 'unhold_item', 'hold_item', 'submit-handoff', 'reserve']);

/** An event's detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** An item's `after` list as ids, numbers where they are numeric. */
const afterOf = (row) => String(row?.item_after ?? '').split(',').filter(Boolean).map(value => (/^\d+$/u.test(value) ? Number(value) : value));

/** The items an `--on` walk can reach, each with its status and own dependencies. */
function reachable(db, start) {
  const items = {};
  const pending = [...start];
  while (pending.length) {
    const id = pending.pop();
    if (items[id] !== undefined || typeof id !== 'number') continue;
    const row = db.prepare('SELECT item_status, item_after FROM item WHERE item_id=?').get(id);
    if (!row) { items[id] = null; continue; }
    items[id] = { status: row.item_status, after: afterOf(row) };
    pending.push(...items[id].after);
  }
  return Object.fromEntries(Object.entries(items).filter(([, value]) => value !== null));
}

/**
 * Run the release table for an ordinary claim release or a review release, over the board as it stands before any write.
 * Why: one table decides the refusal, the release event and the automatic escalation or hold, so the writer carries no second copy of the rules.
 *
 * @param {object} board
 * @param {object} item - The item row before the move.
 * @param {{ agentId: string, note?: string, reasonCode: string, blockedOn?: number[], worktreeSnapshot?: object, reviewer?: string|null, diagnosed: boolean, firstRefusalBuilder?: string|null }} call
 * @returns {{ refused?: object, patch?: object, events?: object[], via?: string[] }}
 */
export function releaseDecision(board, item, call) {
  const { db } = board;
  const id = item.item_id;
  const history = db.prepare(`SELECT event_id id, event_at at, event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN (${KINDS.map(() => '?').join(',')}) ORDER BY event_id`)
    .all(id, ...KINDS).map(e => ({ id: e.id, at: e.at, kind: e.kind, by: e.by, detail: detailOf(e.d) }));
  const lastClaim = history.filter(e => e.kind === 'claim').at(-1) ?? null;
  const seat = db.prepare('SELECT agent_route, agent_path FROM agent WHERE agent_id=?').get(call.agentId);
  const after = afterOf(item);
  const on = call.blockedOn ?? [];
  const snapshot = { revision: 1,
    item: { id, status: item.item_status, owner: item.item_owner, route: item.item_route, after, leaseUntil: item.item_lease_until,
      holdReason: item.item_hold_reason ?? null, holdBy: item.item_hold_by ?? null, reviewer: call.reviewer ?? null },
    actor: { id: call.agentId, route: seat?.agent_route ?? null, path: seat?.agent_path, joined: true }, owner: null, diagnosed: call.diagnosed,
    firstRefusalBuilder: call.firstRefusalBuilder ?? null, items: { [id]: { status: item.item_status, after }, ...reachable(db, [...after, ...on]) },
    history, lastClaim, ownerLastClaimId: lastClaim?.id ?? null, ownerLastLease: null, ownerRegisteredPath: seat?.agent_path };
  const move = { id, actor: call.agentId, root: seat?.agent_path ?? '/seat', reason: call.reasonCode, note: call.note, now: board.clock.now().toISOString(),
    ...(call.blockedOn ? { on: call.blockedOn } : {}), ...(call.worktreeSnapshot ? { worktreeSnapshot: call.worktreeSnapshot } : {}) };
  return runReleaseTable(snapshot, move);
}
