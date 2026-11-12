/** Lapsed claims expire through captured native writes, preserving activity and original ownership [B4,C7,H16]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  itemById,
  firstRefusal,
} from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  appliedSequence,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { LEASE_LAPSE_ENGINE } from '../../../../packages/state/light.js';
import { RELEASE_REASONS_ENGINE } from '../../../../packages/state/light.js';
import { STALE_STATE_ENGINE } from '../../../../packages/state/light.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';

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
  // Prefix holders stay live under their own seat ids, so the scan must step past them without expiring them. Each
  // also records fresh work on its claim: a heartbeat alone no longer keeps a claim 40 minutes past its lease (#3446).
  prefixHolders.forEach((holder, n) => {
    heartbeatSeat(box.board, holder);
    store.appendFact(box.board, unknownIds[n], { agentId: holder, kind: 'note', text: 'Prefix holder still working.' });
  });
  return { box, id, unknownIds };
}

test('clause 1: the next native write frees a lapsed idle claim with one original lease of builder first refusal and named health [B4,C7]', async t => {
  const { box, id } = await lapsed(t);
  const result = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Private fixture write observes lapsed work.']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
  const window = firstRefusal(box.board, id);
  assert.equal(window.builder, box.seats.builder.id);
  assert.equal(Date.parse(window.until) - box.clock.now().getTime(), MINUTE, 'the original lease duration, not the stale age or current configuration');
  const report = healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth: () => ({ findings: [] }) });
  assert.ok(report.waiting.some(entry => entry.cause === 'CLAIM_EXPIRED' && entry.item === id));
  // The window waits only for a builder who can come back; a gone seat's window ends at once (#3447).
  heartbeatSeat(box.board, box.seats.builder.id);
  assert.throws(() => store.claim(box.board, id, { agentId: box.seats.actor.id, lane: 'web', leaseMs: MINUTE, freeze: () => ({ text: 'new', digest: 'new' }) }),
    error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  store.release(box.board, id, box.seats.builder.id, 'Private fixture explicitly returns the original builder reservation.', undefined, 'OTHER');
  assert.equal(firstRefusal(box.board, id), null, 'the builder can explicitly free its reservation');
});

test('coordinator release --stale succeeds once on an unchanged expired lease while legacy floors retain live-only behavior [B4,H16]', async t => {
  const { box, id } = await lapsed(t);
  const result = await cli(box, box.root, ['release', String(id), '--stale', '--reason', 'BLOCKED', '--note', 'Private expired idle fixture claim.', '--no-next']);
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
  // The live heartbeat vetoes lease-lapse expiry; the idle release for a holder with no work for 40 minutes is #3446's.
  assert.equal(captureLapsedClaims({ info: { root: box.root }, config: box.config, clock: box.clock }, box.board, box.seats.actor.id).claims
    .filter(row => row.idle === undefined).length, 0);
  box.advance(62 * MINUTE);
  const missing = store.register(box.board, { lane: 'web', path: box.root + '-missing-worktree', family: 'Fixture unknown work' });
  store.release(box.board, id, box.seats.builder.id, 'Private fixture explicitly returns the original builder reservation.', undefined, 'OTHER');
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
  const released = await cli(box, box.root, ['release', String(id), '--stale', '--reason', 'BLOCKED', '--note', 'Private claim of a gone seat.', '--no-next']);
  assert.equal(released.code, 0, released.out + released.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
  const again = box.add('Second private claim of the same gone seat');
  store.claim(box.board, again, { agentId: ghost, lane: 'web', leaseMs: MINUTE, freeze: () => ({ text: 'private', digest: 'private' }) });
  box.advance(62 * MINUTE);
  // Keep the unrelated builder live: two quiet seats correctly trigger the machine-stall safeguard.
  heartbeatSeat(box.board, box.seats.builder.id);
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
  const replica = openBoard(':memory:', box.clock);
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


test('clause 1: bounded expiry scans advance past thirty-two unknown claims instead of starving a later proven idle holder [B4,C7]', async t => {
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
  const released = await cli(live.box, live.box.root, ['release', String(live.id), '--stale', '--reason', 'BLOCKED', '--note', 'Private live but idle claim retains established release.', '--no-next']);
  assert.equal(released.code, 0, released.out + released.err);
  assert.equal(itemById(live.box.board, live.id).item_status, 'open');
});

test('an expired claim cannot be released without the new explicit feature flag [B4,H16]', async t => {
  const expired = await lapsed(t);
  const snapshot = captureLapsedClaims({ info: { root: expired.box.root }, config: expired.box.config, clock: expired.box.clock }, expired.box.board, expired.box.seats.actor.id);
  const captured = { staleClaim: snapshot.claims[0], observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision, health: {} };
  assert.throws(() => store.release(expired.box.board, expired.id, 'coordinator', 'No new feature flag.', captured, 'BLOCKED'), error => error.code === 'NOT_YOURS');
  assert.equal(itemById(expired.box.board, expired.id).item_status, 'claimed');
});


test('automatic claim expiry records current reason codes while prior lease-lapse replay keeps its event bytes [C7,B4,H16]', async t => {
  const { box, id } = await lapsed(t);
  const snapshot = captureLapsedClaims({ info: { root: box.root }, config: box.config, clock: box.clock }, box.board, box.seats.actor.id);
  assert.equal(snapshot.claims[0].id, id);
  const before = exportBoard(box.board);
  const args = [{ agentId: box.seats.actor.id, snapshot, health: box.config.health ?? {}, claimsOnly: true }];
  // A current capture carries the stranded-dependency limit, which raises the floor; a genuine lease-lapse envelope predates it.
  const { dependency: _dependency, ...legacyLimits } = snapshot.limits;
  const legacyArgs = [{ ...args[0], snapshot: { ...snapshot, limits: legacyLimits } }];
  const move = prepareEngineMove(box.board, 'maintainStaleState', args);
  assert.ok(move.engine >= RELEASE_REASONS_ENGINE);
  assert.ok(RELEASE_REASONS_ENGINE > LEASE_LAPSE_ENGINE);
  assert.equal(minimumMoveEngine('maintainStaleState', legacyArgs), LEASE_LAPSE_ENGINE,
    'genuine accepted lease-lapse envelopes retain their original operation floor');
  const releaseRows = [];
  for (const [engine, coded] of [[move.engine, true], [LEASE_LAPSE_ENGINE, false]]) {
    const replica = openBoard(':memory:', box.clock);
    t.after(() => store.closeBoard(replica));
    importBoard(replica, before);
    const applied = applyRelayMove(replica, { ...move, ...(coded ? {} : { args: legacyArgs }), engine }, { sequence: appliedSequence(replica) + 1,
      at: box.clock.now().toISOString(), kind: 'move',
      sender: { kind: 'agent', agent: box.seats.actor.id, userId: 'fixture-user' } });
    assert.equal(applied.error, undefined, JSON.stringify(applied));
    const released = applied.events.find(event => event.event_kind === 'release' && event.item_id === id);
    assert.ok(released, 'the actual ordered native operation emits the release');
    releaseRows.push(released);
    const detail = JSON.parse(released.event_detail);
    assert.equal(detail.reason, 'Lapsed claim idle past its stale interval.');
    assert.equal(Object.hasOwn(detail, 'reasonCode'), coded);
    assert.equal(detail.reasonCode, coded ? 'OTHER' : undefined);
    assert.deepEqual(detail.expiredClaim, { holder: box.seats.builder.id, leaseUntil: snapshot.claims[0].leaseUntil,
      lastActivity: snapshot.claims[0].lastActivity, observedAt: snapshot.observedAt, leaseEventId: snapshot.claims[0].leaseEventId });
    const window = { builder: box.seats.builder.id, until: new Date(box.clock.now().getTime() + MINUTE).toISOString() };
    assert.deepEqual(detail.reopenFirstRefusal, window);
    assert.deepEqual(firstRefusal(replica, id), window);
    assert.equal(itemById(replica, id).item_status, 'open');
  }
  const codedDetail = JSON.parse(releaseRows[0].event_detail);
  delete codedDetail.reasonCode;
  assert.deepEqual({ ...releaseRows[0], event_detail: JSON.stringify(codedDetail) }, releaseRows[1],
    'the release row differs only by the current engine reasonCode field');
  assert.deepEqual(exportBoard(box.board), before, 'both replay controls leave the original native fixture unchanged');
});


test('clause 1: explicit stale CLI releases require a code before observation and retain coded expired-lease authority [C7,B4,H16]', async t => {
  const { box, id } = await lapsed(t);
  const note = 'The private expired holder is genuinely idle.';
  const before = exportBoard(box.board);
  for (const noteArgs of [[], ['--note', note]]) {
    const missing = await cli(box, box.root, ['release', String(id), '--stale', ...noteArgs, '--no-next']);
    assert.equal(missing.code, 1, missing.out + missing.err);
    assert.equal(missing.document.error.code, 'RELEASE_REASON');
    assert.match(missing.document.error.message, /--reason INELIGIBLE\|ROUTED_ELSEWHERE\|BLOCKED\|BUDGET\|TAKEN_OVER\|DIAGNOSIS_WRONG\|INFRA\|OTHER/u);
    assert.deepEqual(exportBoard(box.board), before, 'missing code cannot observe, free or rewrite the claim');
  }
  const missingNote = await cli(box, box.root, ['release', String(id), '--stale', '--reason', 'BLOCKED', '--no-next']);
  assert.equal(missingNote.code, 1, missingNote.out + missingNote.err);
  assert.equal(missingNote.document.error.code, 'NOTE_REQUIRED');
  assert.deepEqual(exportBoard(box.board), before, 'a valid code retains the stale note requirement');
  const snapshot = captureLapsedClaims({ info: { root: box.root }, config: box.config, clock: box.clock }, box.board, 'coordinator');
  const move = prepareEngineMove(box.board, 'release', [id, 'coordinator', note,
    { leaseLapse: true, staleClaim: snapshot.claims.find(row => row.id === id), observedAt: snapshot.observedAt,
      observedRevision: snapshot.observedRevision, health: box.config.health ?? {} }, 'BLOCKED']);
  assert.ok(move.engine >= RELEASE_REASONS_ENGINE);
  assert.ok(minimumMoveEngine('release', move.args) >= RELEASE_REASONS_ENGINE,
    'a supplied code cannot be interpreted by an older writer that drops it, even when a newer release floor also applies');
  const result = await cli(box, box.root, ['release', String(id), '--stale', '--reason', 'BLOCKED', '--note', note, '--no-next']);
  assert.equal(result.code, 0, result.out + result.err);
  const event = store.events(box.board, { itemId: id }).findLast(row => row.event_kind === 'release');
  const detail = JSON.parse(event.event_detail);
  assert.equal(detail.reasonCode, 'BLOCKED');
  assert.equal(detail.reason, note);
  assert.equal(detail.expiredClaim.holder, box.seats.builder.id);
  assert.equal(detail.expiredClaim.leaseUntil, snapshot.claims.find(row => row.id === id).leaseUntil);
  assert.deepEqual(detail.reopenFirstRefusal, { builder: box.seats.builder.id,
    until: new Date(box.clock.now().getTime() + MINUTE).toISOString() });
  assert.deepEqual(firstRefusal(box.board, id), detail.reopenFirstRefusal);
  assert.equal(itemById(box.board, id).item_status, 'open');
});
