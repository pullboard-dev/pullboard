/** A seat's returned rejections are the open items it built with a REJECT verdict, echoed on one line, from the items front door [C7,#2220]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsJudgement } from '../../index.js';
import { rejectionEchoLine } from '../../index.js';
import { returnedRejections } from '../../index.js';

test('items.returned-rejections.lists-own-open-rejects: clause 1: returnedRejections(items, agentId) keeps only open items whose verdict is REJECT and whose builder is the agent, and rejectionEchoLine names the item id, the clause when present and the verdict note on one line [C7,#2220]', () => {
  const items = [
    { item_id: 1, item_status: 'open', item_verdict: 'REJECT', item_built_by: 'core-1' },
    { item_id: 2, item_status: 'open', item_verdict: 'REJECT', item_built_by: 'core-2' },
    { item_id: 3, item_status: 'claimed', item_verdict: 'REJECT', item_built_by: 'core-1' },
    { item_id: 4, item_status: 'open', item_verdict: null, item_built_by: 'core-1' },
    { item_id: 5, item_status: 'open', item_verdict: 'REJECT', item_built_by: 'core-1' },
  ];
  assert.deepEqual(returnedRejections(items, 'core-1').map(item => item.item_id), [1, 5]);
  assert.deepEqual(returnedRejections([], 'core-1'), []);
  const withClause = rejectionEchoLine({ id: 7, title: 'Add the guard', reason: 'INSUFFICIENT_EVIDENCE', clause: 2, note: 'no case\nproves it' });
  assert.equal(withClause, 'rejected #7 Add the guard: INSUFFICIENT_EVIDENCE, clause 2: no case proves it');
  assert.ok(!withClause.includes('\n'));
  assert.equal(rejectionEchoLine({ id: 8, reason: 'BAR', note: 'unclear' }), 'rejected #8: BAR: unclear');
});

test('items.returned-rejections.front-door-exports: clause 2: returnedRejections, rejectionEchoLine and needsJudgement are exported from the items front door, the door the sibling echo and needs-judgement slices import [C7,#2220]', () => {
  assert.equal(typeof returnedRejections, 'function');
  assert.equal(typeof rejectionEchoLine, 'function');
  assert.deepEqual(needsJudgement([{ id: 1, reason: 'wall', attempts: 2 }, { id: 2, reason: 'rework' }]), [{ id: 1, reason: 'wall', refusalText: '', attempts: 2 }]);
});
