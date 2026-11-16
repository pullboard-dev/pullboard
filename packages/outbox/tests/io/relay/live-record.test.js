/** With moves.live.outbox on, the relay outbox writer refuses what the outbox table refuses and keeps the state it decides; off, its own rules decide [C7,#8391]. */
/** @pullboard-test-input packages/outbox/src/io/relay/shadow.js packages/outbox/src/io/relay.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { provideOutboxTable } from '../../../index.js';
import { liveOutbox } from '../../../index.js';

const doc = (...parked) => ({ baseSequence: 4, moves: parked.map(is => ({ parked: is ? { code: 'X' } : undefined })) });
// The moves cell sits above the outbox cell, so this stands in for the outbox table's queue and park rows.
const table = (snapshot, move) => {
  const { outbox } = snapshot;
  if (move.name === 'queue') return { patch: { outbox: { ...outbox, moves: outbox.moves + 1, state: 'sent' } } };
  return { patch: { outbox: { ...outbox, parked: outbox.parked + 1, state: 'parked' } } };
};

/** Provide a table with the live setting as given, and take it away again after the test. */
function provided(t, { live, decide = table }) {
  provideOutboxTable(decide, () => false, () => live);
  t.after(() => provideOutboxTable(null));
}

test('clause 1: with moves.live.outbox on, a queue and a park leave the outbox in the state the outbox table decides [C7,#8391]', t => {
  provided(t, { live: true });
  const queued = doc(false);
  assert.equal(liveOutbox('queue', doc(), queued), true);
  assert.equal(queued.state, 'sent', 'the queue took the table\'s state, not the one its moves imply');
  const parked = doc(true);
  assert.equal(liveOutbox('park', doc(false), parked), true);
  assert.equal(parked.state, 'parked');
});

test('clause 2: with moves.live.outbox on, a move the table refuses is refused with the table\'s code and next step and changes nothing [C7,#8391]', t => {
  provided(t, { live: true, decide: () => ({ refused: { code: 'OUTBOX_ILLEGAL_MOVE', message: 'an outbox that is undone cannot queue', next: 'from undone the legal moves are: apply, resume' } }) });
  const after = doc(false);
  assert.throws(() => liveOutbox('queue', doc(), after), error => error.code === 'OUTBOX_ILLEGAL_MOVE' && error.next === 'from undone the legal moves are: apply, resume');
  assert.equal('state' in after, false, 'a refused move leaves the document as it was');
});

test('clause 3: with moves.live.outbox off (the default) the writer\'s own rules decide and the table is never run [C7,#8391]', t => {
  provided(t, { live: false, decide: () => { throw new Error('the table must not run'); } });
  const after = doc(false);
  assert.equal(liveOutbox('queue', doc(), after), false);
  assert.equal('state' in after, false);
});
