/** With the real store, withdrawing a gate ends its drive hop, so the driver's next renew is refused and it posts no further step [C7,#3860,#10224]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { createJob } from '../../../../../jobs/index.js';
import { cancelGateJob } from '../../../../../store/index.js';
import { gateHopMove } from '../../../../../store/index.js';
import { readGateHop } from '../../../../../store/index.js';
import { admitGateDrive } from '../../../../../drive/index.js';
import { renewGateDriveHop } from '../../../../../drive/index.js';

const NOW = 1_000_000;
const LEASE_MS = 120_000;

/** The hop table's rows the drive needs: create, acquire a queued hop, and step only as the owner of a driven hop at its epoch. */
function decide(hop, move) {
  if (move.name === 'create') return { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: 'c0ffee', digest: 'd1' } };
  if (move.name === 'acquire') return { hop: { ...hop, state: 'driven', owner: move.actor, epoch: hop.epoch + 1, leaseUntil: NOW + LEASE_MS } };
  return hop.state === 'driven' && hop.owner === move.actor && hop.epoch === move.epoch ? { hop: { ...hop, leaseUntil: NOW + LEASE_MS } }
    : { refused: { code: 'HOP_FENCED', message: `${move.actor} at epoch ${move.epoch} does not own this hop (state ${hop.state}, epoch ${hop.epoch})` } };
}

/** A board with item 7's gate job offered and its drive admitted under gate.fencedHop. */
function driven(t) {
  const board = fixtureBoard(t);
  const hop = { enabled: true, item: 7, write: gateHopMove, decide };
  createJob(board.db, { id: 'gate:7:abc:t', kind: 'gate', item: 7, now: NOW });
  admitGateDrive(board.db, 'handoff-a', { owner: 'driver-a', now: NOW, hop });
  return { board, hop };
}

test('board.withdrawn-gate-drive.withdraw-ends-the-hop: clause 1: after gate --withdraw cancels the item\'s gate job, renewGateDriveHop for the driving owner is refused and the drive posts no further step [C7,#3860]', t => {
  const { board, hop } = driven(t);
  assert.equal(renewGateDriveHop(board.db, 'handoff-a', { owner: 'driver-a', hop }).hop.owner, 'driver-a', 'the driver renews before the withdraw');
  assert.equal(cancelGateJob(board, 7, { now: NOW + 1 }).written, true);
  const before = readGateHop(board.db, 7);
  assert.equal(before.state, 'ended');
  assert.throws(() => renewGateDriveHop(board.db, 'handoff-a', { owner: 'driver-a', hop }), error => error.code === 'HOP_FENCED');
  assert.deepEqual(readGateHop(board.db, 7), before, 'the refused renew wrote no step');
});
