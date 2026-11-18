/** Foreign waits: a withdrawn one yields a hold reason, an open one still blocks without a hold [XB1,E32]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foreignBlockers } from '../../../src/logic/cross/repo.js';

const OWN = 'a'.repeat(32);
const CHILD = 'b'.repeat(32);

/** A board stub holding one signed two-approval states link to the repo "other". */
function boardWithLink() {
  const link = { version: 1, linkId: 'link-1', generation: 1, disclosure: 'states', revocation: null,
    parent: { boardId: OWN, organization: 'org', handle: 'self' }, child: { boardId: CHILD, organization: 'org', handle: 'other' },
    approvals: [{ boardId: OWN }, { boardId: CHILD }] };
  return { db: { prepare: (sql) => (sql.includes("meta_key='board_id'")
    ? { get: () => ({ meta_value: OWN }) }
    : { all: () => [{ meta_value: JSON.stringify(link) }] }) } };
}

/** The announced state of item 3 on the child board. */
const announce = (state) => ({ readReceivedBoardState: () => ({ sourceBoardId: CHILD, destinationBoardId: OWN, linkId: 'link-1', generation: 1,
  disclosure: 'states', position: 1, rows: [{ board: CHILD, id: 3, state }] }) });

test('items.cross-repo.withdrawn-hold: clause 1: a foreign wait whose announced state is withdrawn yields a hold reason naming repo#id and the withdrawal [XB1,E32]', () => {
  const [blocker, ...rest] = foreignBlockers(boardWithLink(), { item_after: 'other#3' }, announce('withdrawn'));
  assert.equal(rest.length, 0);
  assert.equal(blocker.status, 'withdrawn');
  assert.match(blocker.hold, /^other#3 was withdrawn on its own board; /u);
});

test('items.cross-repo.open-still-blocks: clause 2: an open foreign wait still blocks without a hold [XB1,E32]', () => {
  const [blocker, ...rest] = foreignBlockers(boardWithLink(), { item_after: 'other#3' }, announce('open'));
  assert.equal(rest.length, 0);
  assert.equal(blocker.status, 'open');
  assert.equal(blocker.hold, undefined);
  assert.deepEqual(foreignBlockers(boardWithLink(), { item_after: 'other#3' }, announce('verified')), []);
});
