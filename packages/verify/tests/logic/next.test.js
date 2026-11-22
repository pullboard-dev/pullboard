/** Review returns skip a merge check for the exact trunk tip and retain conflict returns [N2]. */
import assert from 'node:assert/strict';
import { mainCheckout } from '../../../git/index.js';
import { test } from 'node:test';
import { returnUnmergeable } from '../../index.js';

test('verify.logic-next.cut-merge-check-keeps-returns: clause 1: returnUnmergeable returns conflicting submitted items and never cleanly mergeable ones after the verify-owned cut [N2]', async () => {
  const root = import.meta.dirname;
  const trunkHead = mainCheckout(root)?.commit;
  assert.ok(trunkHead, 'the test repository has a recorded trunk tip');
  const items = [
    { item_id: 1, item_status: 'submitted', item_commit: trunkHead },
    { item_id: 2, item_status: 'submitted', item_commit: 'conflicting-head' },
    { item_id: 3, item_status: 'open', item_commit: 'ignored-head' },
  ];
  const checked = [];
  const reopened = [];
  const board = { db: { prepare: () => ({ get: () => undefined }) } };
  const returned = await returnUnmergeable(root, board, { id: 'reviewer' }, {
    ordered: async (operation, args) => { reopened.push([operation, ...args]); },
    trunkMerge: (_root, head) => {
      checked.push(head);
      return { commit: trunkHead, files: ['packages/verify/src/logic/next.js'] };
    },
    listItems: () => items,
    itemById: id => items.find(item => item.item_id === id),
  });
  assert.deepEqual(checked, ['conflicting-head'], 'the trunk tip is known clean without invoking Git merge-tree');
  assert.deepEqual(reopened, [['reopen', 2, { agentId: 'reviewer', automaticConflict: true }]]);
  assert.deepEqual(returned, [{ id: 2, files: ['packages/verify/src/logic/next.js'] }]);
});
