/** Items opened from a Pipeline count shows exactly the items the count named [N26,#6869]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectItemsView } from '../../src/logic/selection.js';

test('view.x-selection.clause-2-the-ids-state-shows-only: clause 2: the ids state shows only the named items, whatever their stage, and says where they came from [N26,#6869]', () => {
  const items = [1, 2, 3, 4, 5].map(id => ({ id, title: 'Item ' + id, lane: id % 2 ? 'core' : 'view', status: id === 5 ? 'withdrawn' : id === 4 ? 'verified' : 'open', updatedAt: '2026-11-13T00:0' + id + ':00Z' }));
  const stateById = new Map(items.map(item => [item.id, { state: item.status === 'verified' ? 'verified' : item.status === 'withdrawn' ? 'withdrawn' : 'open', gated: false, merged: item.id === 4 || item.id === 5 }]));
  const view = selectItemsView({ items, stateById, state: 'ids', ids: [4, 2, 5, 99] });
  assert.deepEqual(view.shown.map(item => item.id).sort(), [2, 4, 5], 'the named items that exist, a landed one included, and one withdrawn once met');
  assert.equal(view.stateOptions.find(option => option.value === 'ids').label, 'From Pipeline');
  assert.equal(view.filterLabel, 'Filter: From Pipeline');
  assert.deepEqual(selectItemsView({ items, stateById, state: 'active' }).shown.map(item => item.id).sort(), [1, 2, 3], 'other states are unchanged: withdrawn work stays out');
  assert.equal(selectItemsView({ items, stateById, state: 'active' }).stateOptions.some(option => option.value === 'ids'), false, 'the choice shows only while chosen');
});
