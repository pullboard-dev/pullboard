/** A coordinator stale release compares the claimed item's own events when the command captured them, so a busy board cannot refuse it forever [C7,#10598]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { staleClaimRelease } from '../../../../index.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ID = 5;
const HOLDER = 'core-1';
const LEASE = '2026-11-17T14:00:00.000Z';

/**
 * A board holding one idle claim on item 5 (claim event 1) and the stale observation the coordinator captured at revision 1.
 * With itemScoped, the observation also carries the item's own revision, as `pullboard release --stale` captures it with
 * release.staleItemRevision on.
 */
function claimed(itemScoped) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, item_id INTEGER, event_by TEXT, event_kind TEXT, event_at TEXT, event_detail TEXT)');
  db.exec('CREATE TABLE agent (agent_id TEXT, agent_path TEXT)');
  db.prepare('INSERT INTO agent VALUES (?, ?)').run(HOLDER, '/seat');
  db.prepare("INSERT INTO event (item_id, event_by, event_kind, event_at, event_detail) VALUES (?, ?, 'claim', ?, '{}')").run(ID, HOLDER, new Date(NOW - 3 * 3_600_000).toISOString());
  const board = { db, clock: { now: () => new Date(NOW) } };
  const item = { item_id: ID, item_status: 'claimed', item_owner: HOLDER, item_lease_until: LEASE };
  const row = { id: ID, actor: HOLDER, leaseUntil: LEASE, claimEventId: 1, lastActivity: new Date(NOW - 2 * 3_600_000).toISOString(),
    evidence: { complete: true }, limitMs: 3_600_000, blocker: false };
  const captured = { staleClaim: row, observedAt: new Date(NOW - 60_000).toISOString(), observedRevision: 1, ...(itemScoped ? { itemRevision: 1 } : {}), health: {} };
  const event = (itemId) => db.prepare("INSERT INTO event (item_id, event_by, event_kind, event_at, event_detail) VALUES (?, 'core-2', 'fact', ?, '{}')").run(itemId, new Date(NOW - 30_000).toISOString());
  return { release: () => staleClaimRelease(board, item, 'coordinator', 'idle 2h', captured), event };
}

const CHANGED = { code: 'NOT_YOURS', message: /the claim changed after the stale observation; capture it again before releasing/u };

test('store.stale-claim.item-revision-other-items: clause 1: with release.staleItemRevision on, an idle claim releases when only other items gained events after the observed revision [C7,#10598]', () => {
  const board = claimed(true);
  board.event(9);
  board.event(12);
  const released = board.release();
  assert.equal(released.holder, HOLDER, 'the idle claim is released');
  assert.equal(released.claimEventId, 1);
});

test('store.stale-claim.item-revision-own-event: clause 2: with release.staleItemRevision on, an event on the released item after the observed revision still refuses NOT_YOURS [C7,#10598]', () => {
  const board = claimed(true);
  board.event(9);
  board.event(ID);
  assert.throws(() => board.release(), CHANGED);
});

test('store.stale-claim.board-revision-default: clause 3: with release.staleItemRevision off (the default), any new board event after the observed revision still refuses NOT_YOURS [C7,#10598]', () => {
  const board = claimed(false);
  board.event(9);
  assert.throws(() => board.release(), CHANGED);
  assert.equal(claimed(false).release().holder, HOLDER, 'with no new event the same observation releases');
});
