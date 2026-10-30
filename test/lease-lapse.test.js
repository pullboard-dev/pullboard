/** @pullboard-test-input source-tree */
/** Lapsed claims expire through captured native writes, preserving activity and original ownership [B4,C7,H16]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, cli } from './next-take-fixture.js';
import * as store from '../src/board.js';
import { itemById, firstRefusal } from '../src/board-item-read.js';
import { heartbeatSeat } from '../src/seat-presence.js';
import { captureLapsedClaims } from '../packages/health/index.js';
import { healthReport } from '../packages/health/index.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { appliedSequence, applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { LEASE_LAPSE_ENGINE } from '../src/lease-lapse-engine.js';
import { STALE_STATE_ENGINE } from '../src/stale-state-engine.js';
import { minimumMoveEngine } from '../src/move-registry.js';

const MINUTE = 60_000;

/** Keep genuine worktree/reflog observations behind a private injected clock, never alter production timestamps. */
async function lapsed(t, { leaseMs = MINUTE, unknownPrefix = 0 } = {}) {
  const box = await fixture(t);
  box.advance(Math.ceil(Date.now() / 1000) * 1000 + 10_000 - box.clock.now().getTime());
  const unknownIds = [], prefixHolders = [];
  for (let n = 0; n < unknownPrefix; n++) {
    const holder = store.register(box.board, { lane: 'web', path: box.root + '-unknown-' + n, family: 'Fixture unknown work' });
    const pending = box.add('Unknown work prefix ' + n);
    unknownIds.push(pending); prefixHolders.push(holder);
    store.claim(box.board, pending, { agentId: holder, lane: 'web', leaseMs: MINUTE,
      freeze: item => ({ text: item.item_title, digest: 'unknown-prefix-fixture' }) });
    heartbeatSeat(box.board, holder);
  }
  const id = box.add('Private claim whose lease genuinely lapses');
  heartbeatSeat(box.board, box.seats.builder.id);
  store.claim(box.board, id, { agentId: box.seats.builder.id, lane: 'web', leaseMs,
    freeze: item => ({ text: item.item_title, digest: 'lease-lapse-fixture' }) });
  box.advance(62 * MINUTE);
  // Prefix holders stay live under their own seat ids, so the scan must step past them without expiring them.
  for (const holder of prefixHolders) heartbeatSeat(box.board, holder);
  return { box, id, unknownIds };
}

test('the next native write frees a lapsed idle claim with one original lease of builder first refusal and named health [B4,C7]', async t => {
  const { box, id } = await lapsed(t);
  const result = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Private fixture write observes lapsed work.']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
  const window = firstRefusal(box.board, id);
  assert.equal(window.builder, box.seats.builder.id);
  assert.equal(Date.parse(window.until) - box.clock.now().getTime(), MINUTE, 'the original lease duration, not the stale age or current configuration');
  const report = healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth: () => ({ findings: [] }) });
  assert.ok(report.waiting.some(entry => entry.cause === 'CLAIM_EXPIRED' && entry.item === id));
  assert.throws(() => store.claim(box.board, id, { agentId: box.seats.actor.id, lane: 'web', leaseMs: MINUTE, freeze: () => ({ text: 'new', digest: 'new' }) }),
    error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  store.release(box.board, id, box.seats.builder.id);
  assert.equal(firstRefusal(box.board, id), null, 'the builder can explicitly free its reservation');
});

test('coordinator release --stale succeeds once on an unchanged expired lease while legacy floors retain live-only behavior [B4,H16]', async t => {
  const { box, id } = await lapsed(t);
  const result = await cli(box, box.root, ['release', String(id), '--stale', '--note', 'Private expired idle fixture claim.', '--no-next']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
  assert.equal(firstRefusal(box.board, id).builder, box.seats.builder.id);
  assert.equal(minimumMoveEngine('release', [id, 'coordinator', 'old', { staleClaim: {} }]), STALE_STATE_ENGINE);
  assert.equal(minimumMoveEngine('release', [id, 'coordinator', 'new', { staleClaim: {}, leaseLapse: true }]), LEASE_LAPSE_ENGINE);
});

test('a live holder heartbeat vetoes expiry, and a gone checkout with no activity under its seat id frees [B3,B4,C7]', async t => {
  const { box, id } = await lapsed(t);
  heartbeatSeat(box.board, box.seats.builder.id);
  const result = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Private write retains active holder.']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(itemById(box.board, id).item_status, 'claimed');
  assert.equal(captureLapsedClaims({ info: { root: box.root }, config: box.config, clock: box.clock }, box.board, box.seats.actor.id).claims.length, 0);
  box.advance(62 * MINUTE);
  const missing = store.register(box.board, { lane: 'web', path: box.root + '-missing-worktree', family: 'Fixture unknown work' });
  store.release(box.board, id, box.seats.builder.id);
  store.claim(box.board, id, { agentId: missing, lane: 'web', leaseMs: MINUTE, freeze: () => ({ text: 'private', digest: 'private' }) });
  heartbeatSeat(box.board, missing);
  box.advance(62 * MINUTE);
  // The claim belongs to the seat id: a missing worktree is absence, never unknown evidence (#1933).
  const gone = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Private write frees a gone checkout.']);
  assert.equal(gone.code, 0, gone.out + gone.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
  assert.equal(firstRefusal(box.board, id).builder, missing);
});

test('a seat with no presence at all frees on the next write, and release --stale takes one call [B4,C7]', async t => {
  const { box } = await lapsed(t);
  const ghost = store.register(box.board, { lane: 'web', path: box.root + '-never-seen', family: 'Fixture gone seat' });
  const id = box.add('Private claim held by a seat that never reported presence');
  store.claim(box.board, id, { agentId: ghost, lane: 'web', leaseMs: MINUTE, freeze: () => ({ text: 'private', digest: 'private' }) });
  box.advance(62 * MINUTE);
  const released = await cli(box, box.root, ['release', String(id), '--stale', '--note', 'Private claim of a gone seat.', '--no-next']);
  assert.equal(released.code, 0, released.out + released.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
  const again = box.add('Second private claim of the same gone seat');
  store.claim(box.board, again, { agentId: ghost, lane: 'web', leaseMs: MINUTE, freeze: () => ({ text: 'private', digest: 'private' }) });
  box.advance(62 * MINUTE);
  const write = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Private write frees a gone seat.']);
  assert.equal(write.code, 0, write.out + write.err);
  assert.equal(itemById(box.board, again).item_status, 'open');
});

test('fresh file activity in a lapsed holder checkout is not seat activity and never keeps the claim [B4,C7]', async t => {
  const { box, id } = await lapsed(t);
  writeFileSync(join(box.seats.builder.path, 'private-recent-edit.txt'), 'edited by some other process\n');
  const result = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Private write ignores checkout files.']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
});

test('sealed lapsed-claim expiry replays identically despite fresh replica-local heartbeat and refuses a changed revision [B4,H16]', async t => {
  const { box, id } = await lapsed(t);
  const snapshot = captureLapsedClaims({ info: { root: box.root }, config: box.config, clock: box.clock }, box.board, box.seats.actor.id);
  assert.equal(snapshot.claims[0].id, id);
  const replica = store.openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(box.board));
  heartbeatSeat(replica, box.seats.builder.id);
  const move = prepareEngineMove(box.board, 'maintainStaleState', [{ agentId: box.seats.actor.id, snapshot, health: box.config.health ?? {}, claimsOnly: true }]);
  const applied = applyRelayMove(replica, move, { sequence: appliedSequence(replica) + 1, at: box.clock.now().toISOString(),
    kind: 'move', sender: { kind: 'agent', agent: box.seats.actor.id, userId: 'fixture-user' } });
  assert.equal(applied.error, undefined, JSON.stringify(applied));
  assert.equal(itemById(replica, id).item_status, 'open');
  store.appendFact(box.board, id, { agentId: 'coordinator', kind: 'note', text: 'A real native change invalidates the captured event prefix.' });
  assert.throws(() => store.maintainStaleState(box.board, { agentId: box.seats.actor.id, snapshot, health: {}, claimsOnly: true }), error => error.code === 'STALE_STATE_CHANGED');
  assert.equal(itemById(box.board, id).item_status, 'claimed');
});


test('bounded expiry scans advance past thirty-two unknown claims instead of starving a later proven idle holder [B4,C7]', async t => {
  const { box, id, unknownIds } = await lapsed(t, { unknownPrefix: 33 });
  const snapshot = captureLapsedClaims({ info: { root: box.root }, config: box.config, clock: box.clock }, box.board, box.seats.actor.id);
  assert.equal(snapshot.claims.length, 0, 'the first captured batch contains only live holders');
  const first = store.maintainStaleState(box.board, { agentId: box.seats.actor.id, snapshot, health: {}, claimsOnly: true });
  assert.deepEqual(first.claims, [], 'one native batch advances without inventing an expiry');
  assert.equal(itemById(box.board, id).item_status, 'claimed', 'the first bounded batch contains only live holders');
  const second = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Second bounded private expiry scan.']);
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(itemById(box.board, id).item_status, 'open', 'the recorded cursor advances despite no expiry in the first batch');
  assert.ok(unknownIds.every(pending => itemById(box.board, pending).item_status === 'claimed'), 'every live holder remains protected in authoritative raw state');
});

test('new lapsed support retains valid live-but-idle coordinator release [B4,H16]', async t => {
  const live = await lapsed(t, { leaseMs: 120 * MINUTE });
  const released = await cli(live.box, live.box.root, ['release', String(live.id), '--stale', '--note', 'Private live but idle claim retains established release.', '--no-next']);
  assert.equal(released.code, 0, released.out + released.err);
  assert.equal(itemById(live.box.board, live.id).item_status, 'open');
});

test('an expired claim cannot be released without the new explicit feature flag [B4,H16]', async t => {
  const expired = await lapsed(t);
  const snapshot = captureLapsedClaims({ info: { root: expired.box.root }, config: expired.box.config, clock: expired.box.clock }, expired.box.board, expired.box.seats.actor.id);
  const captured = { staleClaim: snapshot.claims[0], observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision, health: {} };
  assert.throws(() => store.release(expired.box.board, expired.id, 'coordinator', 'No new feature flag.', captured), error => error.code === 'NOT_YOURS');
  assert.equal(itemById(expired.box.board, expired.id).item_status, 'claimed');
});
