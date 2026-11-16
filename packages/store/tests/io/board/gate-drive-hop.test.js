/** @pullboard-test-input source-cell store */
/** Gate-drive takes and renews its hop through the fenced row when gate.fencedHop is on, and a second driver for the item is refused naming the first [C7,#8274]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { admitGateDrive } from '../../../../drive/index.js';
import { renewGateDriveHop } from '../../../../drive/index.js';
import { readGateDrive } from '../../../../drive/index.js';
import { gateHopMove } from '../../../src/io/board/hop.js';
import { readGateHop } from '../../../src/io/board/hop.js';

const NOW = 1_000_000;
const LEASE_MS = 120_000;

/** The hop table's rows the drive needs, as the caller's decision over the read row: create, acquire a queued or lapsed hop, and step only as the owner. */
function decide(hop, move) {
  if (move.name === 'create') return { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: 'c0ffee', digest: 'd1' } };
  if (move.name === 'acquire') {
    return hop.state === 'queued' || hop.leaseUntil < NOW ? { hop: { ...hop, state: 'driven', owner: move.actor, epoch: hop.epoch + 1, leaseUntil: NOW + LEASE_MS } }
      : { refused: { code: 'HOP_HELD', message: `the hop is driven by ${hop.owner} and its lease has not lapsed` } };
  }
  return hop.owner === move.actor && hop.epoch === move.epoch ? { hop: { ...hop, leaseUntil: NOW + LEASE_MS } }
    : { refused: { code: 'HOP_FENCED', message: `${move.actor} at epoch ${move.epoch} does not own this hop (owner ${hop.owner} at epoch ${hop.epoch})` } };
}

/** A real board file, and the hop port the caller wires for item 7 with the setting as given. */
function fixture(t, enabled) {
  const { db } = cellBoard(t, cellProject(t, { real: true }).boardFile, undefined, { real: true });
  return { db, hop: { enabled, item: 7, write: gateHopMove, decide } };
}

test('clause 1: with gate.fencedHop on, a second gate-drive for the same item is refused HOP_FENCED naming the first [C7,#8274]', t => {
  const { db, hop } = fixture(t, true);
  const first = admitGateDrive(db, 'handoff-a', { owner: 'driver-a', now: NOW, hop });
  assert.equal(first.owner, 'driver-a');
  assert.deepEqual([readGateHop(db, 7).owner, readGateHop(db, 7).epoch], ['driver-a', 1], 'the first driver owns the row at epoch 1');
  assert.throws(() => admitGateDrive(db, 'handoff-b', { owner: 'driver-b', now: NOW, hop }), error => {
    assert.equal(error.code, 'HOP_FENCED');
    assert.match(error.message, /driver-a/u, 'the refusal names the first driver');
    return true;
  });
  assert.equal(readGateHop(db, 7).owner, 'driver-a', 'the refused driver took nothing');
  assert.equal(readGateDrive(db, 'handoff-b')?.owner ?? null, null, 'the refused driver left no admitted record');
});

test('clause 1: with gate.fencedHop on, the driver renews its hop at its epoch and a stale driver is refused HOP_FENCED [C7,#8274]', t => {
  const { db, hop } = fixture(t, true);
  admitGateDrive(db, 'handoff-a', { owner: 'driver-a', now: NOW, hop });
  assert.equal(renewGateDriveHop(db, 'handoff-a', { owner: 'driver-a', hop }).hop.owner, 'driver-a');
  // The hop was retaken at a later epoch behind the driver's back.
  db.prepare('UPDATE gate_hop SET owner=?, epoch=2, version=version+1 WHERE item=7').run('driver-c');
  assert.throws(() => renewGateDriveHop(db, 'handoff-a', { owner: 'driver-a', hop }), error => error.code === 'HOP_FENCED' && /driver-c/u.test(error.message));
});

test('clause 1: with gate.fencedHop off, gate-drive admits two drivers and writes no hop row [C7,#8274]', t => {
  const { db, hop } = fixture(t, false);
  admitGateDrive(db, 'handoff-a', { owner: 'driver-a', now: NOW, hop });
  admitGateDrive(db, 'handoff-b', { owner: 'driver-b', now: NOW, hop });
  assert.deepEqual(renewGateDriveHop(db, 'handoff-a', { owner: 'driver-a', hop }), { off: true });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='gate_hop'").get(), undefined, 'no hop table exists');
});
