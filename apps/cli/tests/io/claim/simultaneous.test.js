/** A claim takes its whole predicted file set or none: a lease conflict leaves the other files free, in either claim order [C7,#1439,#8521]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leaseBoard } from '../../fixtures/claim/lease.js';

const status = (board, id) => board.db.prepare('SELECT item_status AS status, item_owner AS owner FROM item WHERE item_id=?').get(id);

test('cli.journeys-claim-all-at-once.a-claim-meeting-a-leased-file: clause 1: a claim whose predicted files include one a live claim leases takes no lease on its other files, and the refusal names the holder and the file [C7,#1439]', t => {
  const { board, add, claim, first, second } = leaseBoard(t, { hubs: [] });
  const holder = add('Holds the shared file', ['web/shared.js']);
  const blocked = add('Needs the shared file and another', ['web/shared.js', 'web/own.js']);
  const neighbour = add('Needs only the other file', ['web/own.js']);
  claim(holder, first);
  assert.throws(() => claim(blocked, second), error => error.code === 'FILE_LEASED' && error.message.includes('web/shared.js') && error.message.includes(`#${holder}`) && error.message.includes(first));
  assert.equal(status(board, blocked).owner, null, 'the refused claim holds nothing');
  assert.notEqual(status(board, blocked).status, 'claimed');
  claim(neighbour, second);
  assert.equal(status(board, neighbour).status, 'claimed', 'web/own.js was never leased by the refused claim, so a claim on it alone goes through');
});

/** Two items with crossing file sets claimed in that order: the second is refused and holds nothing, the first holds all. */
function crossing(t, firstSet, secondSet) {
  const { board, add, claim, first, second } = leaseBoard(t, { hubs: [] });
  const early = add('Claims first', firstSet);
  const late = add('Claims second', secondSet);
  claim(early, first);
  assert.throws(() => claim(late, second), error => error.code === 'FILE_LEASED');
  assert.equal(status(board, early).status, 'claimed', 'the first claim holds all its files');
  assert.equal(status(board, late).owner, null, 'the second claim holds none');
  assert.notEqual(status(board, late).status, 'claimed');
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_status='claimed'").get().n, 1, 'exactly one claim is live');
}

test('cli.journeys-claim-all-at-once.two-claims-with-crossing-file-sets-one-order: clause 2: two claims with crossing file sets, a/b claimed before b/c, leave exactly one holding all its files and the other holding none [C7,#1439]', t => {
  crossing(t, ['web/a.js', 'web/b.js'], ['web/b.js', 'web/c.js']);
});

test('cli.journeys-claim-all-at-once.two-claims-with-crossing-file-sets-the-other-order: clause 2: two claims with crossing file sets, b/c claimed before a/b, leave exactly one holding all its files and the other holding none [C7,#1439]', t => {
  crossing(t, ['web/b.js', 'web/c.js'], ['web/a.js', 'web/b.js']);
});
