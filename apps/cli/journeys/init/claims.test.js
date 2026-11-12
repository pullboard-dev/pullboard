/** A claim returns when its seat stops heartbeating or its worktree disappears, and live seats keep theirs [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import * as store from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';

const QUIET_MS = 2 * 60_000;

/** Make a claim owned by the fixture builder while keeping the acting seat independently alive. */
function claimedWork(box, title) {
  const id = box.add(title);
  box.claim(id, box.seats.builder);
  return id;
}

/** Trigger the same pre-write maintenance path used by native Pullboard commands. */
async function writeFromActor(box, message) {
  heartbeatSeat(box.board, box.seats.actor.id);
  const result = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', message]);
  assert.equal(result.code, 0, result.out + result.err);
}

/** Read the persisted release event for an item. */
function releaseFor(board, id) {
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='release' ORDER BY event_id DESC LIMIT 1").get(id);
  return event ? JSON.parse(event.event_detail) : null;
}

test('a claim is reopened after its seat has missed heartbeats for two minutes and records the seat [C7]', async t => {
  const box = await fixture(t);
  const id = claimedWork(box, 'Heartbeat quiet claim');
  box.advance(QUIET_MS + 1);

  await writeFromActor(box, 'Observe a quiet claimed seat.');

  assert.equal(store.getItem(box.board, id).item_status, 'open');
  assert.equal(releaseFor(box.board, id)?.reclaim?.seat, box.seats.builder.id);
});

test('a missing seat worktree alone keeps a heartbeating claim, and reopens it once the heartbeat lapses [C7]', async t => {
  const box = await fixture(t);
  const id = claimedWork(box, 'Missing process worktree claim');
  rmSync(box.seats.builder.path, { recursive: true, force: true });

  await writeFromActor(box, 'Observe a missing seat worktree with a live heartbeat.');

  assert.equal(store.getItem(box.board, id).item_status, 'claimed');
  box.advance(QUIET_MS + 1);

  await writeFromActor(box, 'Observe a missing seat worktree with a lapsed heartbeat.');

  assert.equal(store.getItem(box.board, id).item_status, 'open');
  assert.equal(releaseFor(box.board, id)?.reclaim?.seat, box.seats.builder.id);
  assert.equal(releaseFor(box.board, id)?.reclaim?.worktreeMissing, true);
});

test('a seat that heartbeats within two minutes keeps its claimed work [C7]', async t => {
  const box = await fixture(t);
  const id = claimedWork(box, 'Heartbeating claim');
  box.advance(QUIET_MS + 1);
  heartbeatSeat(box.board, box.seats.builder.id);

  await writeFromActor(box, 'Observe a live claimed seat.');

  assert.equal(store.getItem(box.board, id).item_status, 'claimed');
  assert.equal(store.getItem(box.board, id).item_owner, box.seats.builder.id);
});
