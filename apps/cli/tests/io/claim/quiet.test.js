/** Quiet files run optimistic and busy files take strict leases, by the file's recent conflict rate against queue.contentionThreshold [C7,#1441,#8521]. */
// fixture-subject: addItem
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leaseBoard } from '../../fixtures/claim/lease.js';

const THRESHOLD = 1;

/** Record one conflict hold naming a file, the way the conflict-rate reader counts it: a hold_item event whose reason names the trunk conflict. */
function seedConflict(board, item, file) {
  board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)')
    .run(board.clock.now().toISOString(), 'coordinator', 'hold_item', item, JSON.stringify({ reason: `conflicts with the trunk at abcdef012345 in ${file}; merge main and resubmit` }));
}

const owner = (board, id) => board.db.prepare('SELECT item_status AS status, item_owner AS owner FROM item WHERE item_id=?').get(id);

test('cli.journeys-claim-quiet-busy.a-quiet-file-takes-two-claims: clause 1: a file whose recent conflict rate is under the threshold is quiet, and two claims on it both proceed [C7,#1441]', t => {
  const { board, add, claim, first, second } = leaseBoard(t, { hubs: [], quietThreshold: THRESHOLD });
  const one = add('First on the quiet file', ['web/quiet.js']);
  const two = add('Second on the quiet file', ['web/quiet.js']);
  claim(one, first);
  claim(two, second);
  assert.equal(owner(board, one).status, 'claimed');
  assert.equal(owner(board, two).status, 'claimed', 'a quiet file is shared, not leased');
  assert.notEqual(owner(board, one).owner, owner(board, two).owner, 'each claim has its own seat');
});

test('cli.journeys-claim-quiet-busy.a-busy-file-refuses-a-second-claim: clause 2: a file at or over the threshold is busy, and a second claim on it is refused by the claims.fileLease lease naming the holder [C7,#1441]', t => {
  const { board, add, claim, first, second } = leaseBoard(t, { hubs: [], quietThreshold: THRESHOLD });
  const one = add('First on the busy file', ['web/busy.js']);
  const two = add('Second on the busy file', ['web/busy.js']);
  seedConflict(board, one, 'web/busy.js');
  claim(one, first);
  assert.throws(() => claim(two, second), error => error.code === 'FILE_LEASED' && error.message.includes('web/busy.js') && error.message.includes(`#${one}`) && error.message.includes(first));
  assert.equal(owner(board, two).owner, null, 'the refused claim holds nothing');
  assert.notEqual(owner(board, two).status, 'claimed');
});
