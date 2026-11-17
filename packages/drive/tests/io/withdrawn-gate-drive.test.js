/** An ended drive hop (what a withdraw leaves) refuses the driver's renew, so the driver's next renew is refused and it posts no further step [C7,#3860,#10224]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { createJob } from '../../../jobs/index.js';
import { admitGateDrive } from '../../index.js';
import { renewGateDriveHop } from '../../index.js';

const NOW = 1_000_000;
const LEASE_MS = 120_000;

/** The hop table's rows the drive needs: create, acquire a queued hop, and step only as the owner of a driven hop at its epoch. */
function decide(hop, move) {
  if (move.name === 'create') return { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: 'c0ffee', digest: 'd1' } };
  if (move.name === 'acquire') return { hop: { ...hop, state: 'driven', owner: move.actor, epoch: hop.epoch + 1, leaseUntil: NOW + LEASE_MS } };
  return hop.state === 'driven' && hop.owner === move.actor && hop.epoch === move.epoch ? { hop: { ...hop, leaseUntil: NOW + LEASE_MS } }
    : { refused: { code: 'HOP_FENCED', message: `${move.actor} at epoch ${move.epoch} does not own this hop (state ${hop.state}, epoch ${hop.epoch})` } };
}

/** An in-memory hop row with the store writer's shape, and the withdraw as the store ends it: ended at the next epoch. */
function memoryHop() {
  const state = { row: null, writes: 0 };
  const write = (_db, { decide }) => { const answer = decide(state.row); if (answer.refused) { const e = new Error(answer.refused.message); e.code = answer.refused.code; throw e; } state.row = answer.hop; state.writes++; return { hop: state.row }; };
  return { state, hop: { enabled: true, item: 7, write, decide }, withdraw: () => { state.row = { ...state.row, state: 'ended', owner: null, epoch: state.row.epoch + 1 }; } };
}

/** A board with item 7's gate job offered and its drive admitted under gate.fencedHop. */
function driven(t) {
  const board = fixtureBoard(t);
  const { state, hop, withdraw } = memoryHop();
  createJob(board.db, { id: 'gate:7:abc:t', kind: 'gate', item: 7, now: NOW });
  admitGateDrive(board.db, 'handoff-a', { owner: 'driver-a', now: NOW, hop });
  return { board, hop, state, withdraw };
}

test('drive.withdrawn-gate-drive.withdraw-ends-the-hop: clause 1: after gate --withdraw cancels the item\'s gate job, renewGateDriveHop for the driving owner is refused and the drive posts no further step [C7,#3860]', t => {
  const { board, hop, state, withdraw } = driven(t);
  assert.equal(renewGateDriveHop(board.db, 'handoff-a', { owner: 'driver-a', hop }).hop.owner, 'driver-a', 'the driver renews before the withdraw');
  withdraw();
  const writes = state.writes;
  assert.throws(() => renewGateDriveHop(board.db, 'handoff-a', { owner: 'driver-a', hop }), error => error.code === 'HOP_FENCED');
  assert.equal(state.writes, writes, 'the refused renew wrote no step');
});

test('drive.withdrawn-gate-drive.setting-off-keeps-stepping: clause 2: with gate.withdrawCancelsJob off nothing ends the hop, so the same drive keeps stepping as today [C7,#3860]', t => {
  const { board, hop, state, withdraw } = driven(t);
  for (let step = 0; step < 2; step++) assert.equal(renewGateDriveHop(board.db, 'handoff-a', { owner: 'driver-a', hop }).hop.owner, 'driver-a');
  assert.equal(state.row.state, 'driven');
});
