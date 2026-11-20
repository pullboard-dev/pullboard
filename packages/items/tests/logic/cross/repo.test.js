import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foreignBlockers } from '../../../src/logic/cross/repo.js';
import { foreignDependencyStates } from '../../../src/logic/cross/repo.js';

const OWN = 'a'.repeat(32);
const CHILD = 'b'.repeat(32);
const ITEM = { item_after: 'child#7' };

/** A signed-shape link from this board to `child`, with its revocation when given. */
function link(revocation = null) {
  const approval = (boardId) => ({ version: 1, type: 'approve', boardId, signature: 'sig' });
  return { version: 1, linkId: 'link-1', parent: { boardId: OWN, organization: 'org', handle: 'parent' }, child: { boardId: CHILD, organization: 'org', handle: 'child' },
    generation: 1, disclosure: 'states', approvals: [approval(OWN), approval(CHILD)], revocation };
}

/** A board whose metadata rows hold the given links, and a reader that returns the received state. */
function setup(links, state) {
  const rows = links.map((record, index) => ({ meta_value: JSON.stringify(record), meta_key: `board_link:${index}` }));
  const board = { db: { prepare: () => ({ get: () => ({ meta_value: OWN }), all: () => rows }) } };
  return { board, ports: { readReceivedBoardState: () => { if (!state) throw new Error('no state'); return state; } } };
}

const received = (rows) => ({ sourceBoardId: CHILD, destinationBoardId: OWN, linkId: 'link-1', generation: 1, disclosure: 'states', position: 1, rows });

test('items.logic-cross-repo.unavailable-names-its-cause: clause 1: [C7] an unavailable foreign state names no link, revoked or no state yet', () => {
  const none = setup([], null);
  assert.deepEqual(foreignDependencyStates(none.board, ITEM, none.ports)[0], { kind: 'foreign', repo: 'child', id: 7, status: 'unavailable', cause: 'no link' });
  const revoked = setup([link({ version: 1, type: 'revoke', boardId: OWN, signature: 'sig' })], null);
  assert.equal(foreignDependencyStates(revoked.board, ITEM, revoked.ports)[0].cause, 'revoked');
  const waiting = setup([link()], null);
  assert.equal(foreignDependencyStates(waiting.board, ITEM, waiting.ports)[0].cause, 'no state yet');
  assert.equal(foreignDependencyStates(waiting.board, ITEM, waiting.ports)[0].status, 'unavailable');
});

test('items.logic-cross-repo.verified-state-has-no-cause: clause 2: [C7] a verified or open foreign state carries no cause field', () => {
  for (const state of ['verified', 'open']) {
    const { board, ports } = setup([link()], received([{ board: CHILD, id: 7, state }]));
    const [ref] = foreignDependencyStates(board, ITEM, ports);
    assert.equal(ref.status, state);
    assert.equal('cause' in ref, false);
  }
});

test('items.logic-cross-repo.blockers-keep-every-unverified-ref: clause 3: [C7] foreignBlockers returns every non-verified ref and drops a verified one', () => {
  const { board, ports } = setup([link()], received([{ board: CHILD, id: 7, state: 'verified' }]));
  assert.deepEqual(foreignBlockers(board, ITEM, ports), []);
  const open = setup([link()], received([{ board: CHILD, id: 7, state: 'open' }]));
  assert.equal(foreignBlockers(open.board, ITEM, open.ports).length, 1);
  const none = setup([], null);
  assert.equal(foreignBlockers(none.board, { item_after: 'child#7,child#8' }, none.ports).length, 2);
});

test('items.cross-repo.withdrawn-hold: clause 1: a foreign wait whose announced state is withdrawn yields a hold reason naming repo#id and the withdrawal [XB1,E32]', () => {
  const { board, ports } = setup([link()], received([{ board: CHILD, id: 7, state: 'withdrawn' }]));
  const [blocker, ...rest] = foreignBlockers(board, ITEM, ports);
  assert.equal(rest.length, 0);
  assert.equal(blocker.status, 'withdrawn');
  assert.match(blocker.hold, /^child#7 was withdrawn on its own board; /u);
});

test('items.cross-repo.open-still-blocks: clause 2: an open foreign wait still blocks without a hold [XB1,E32]', () => {
  const open = setup([link()], received([{ board: CHILD, id: 7, state: 'open' }]));
  const [blocker, ...rest] = foreignBlockers(open.board, ITEM, open.ports);
  assert.equal(rest.length, 0);
  assert.equal(blocker.status, 'open');
  assert.equal(blocker.hold, undefined);
  const verified = setup([link()], received([{ board: CHILD, id: 7, state: 'verified' }]));
  assert.deepEqual(foreignBlockers(verified.board, ITEM, verified.ports), []);
});

test('items.logic-cross-repo.state-carries-received-at: clause 1: a foreign state passes the received time of its board state through, and has none when the state has none [E32]', () => {
  const stamped = setup([link()], { ...received([{ board: CHILD, id: 7, state: 'open' }]), receivedAt: '2026-11-19T01:02:03.000Z' });
  const [withTime] = foreignDependencyStates(stamped.board, ITEM, stamped.ports);
  assert.equal(withTime.receivedAt, '2026-11-19T01:02:03.000Z');
  const plain = setup([link()], received([{ board: CHILD, id: 7, state: 'open' }]));
  const [without] = foreignDependencyStates(plain.board, ITEM, plain.ports);
  assert.equal('receivedAt' in without, false);
});
