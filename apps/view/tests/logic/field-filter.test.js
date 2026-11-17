/** The view filters the item list and roadmap by a typed field, and clearing the filter restores everything [C7,#1321]. */
/** @pullboard-test-input source-cell apps/view */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectItemsView } from '../../src/logic/selection.js';
import { readMilestoneModel } from '../../src/io/roadmap/render.js';

const field = (name, value) => ({ name, type: 'choice', value });
const items = [[1, 'high'], [2, 'low'], [3, 'high'], [4, null]].map(([id, priority]) => ({
  id, title: 'Item ' + id, lane: 'view', status: 'open', updatedAt: '2026-11-16T00:0' + id + ':00Z', fields: priority ? [field('priority', priority)] : [],
}));
const stateById = new Map(items.map(item => [item.id, { state: 'open', gated: false, merged: false }]));
const ids = view => view.shown.map(item => item.id).sort();
const milestone = { name: '0.9.5', items: items.map(item => item.id) };
const rows = items.map(item => ({ ...item, state: 'open', stage: 'ready', label: '#' + item.id, why: item.title }));

test('clause 1: choosing priority=high leaves only the items whose priority field is high in the list and the roadmap [C7,#1321]', () => {
  const fieldFilter = { name: 'priority', value: 'high' };
  assert.deepEqual(ids(selectItemsView({ items, stateById, state: 'active', fieldFilter })), [1, 3]);
  assert.deepEqual(readMilestoneModel(milestone, rows, fieldFilter).rows.map(row => row.id).sort(), [1, 3]);
});

test('clause 2: clearing the filter restores the full list and roadmap [C7,#1321]', () => {
  for (const fieldFilter of [null, undefined, { name: '', value: '' }]) {
    assert.deepEqual(ids(selectItemsView({ items, stateById, state: 'active', fieldFilter })), [1, 2, 3, 4]);
    assert.deepEqual(readMilestoneModel(milestone, rows, fieldFilter).rows.map(row => row.id).sort(), [1, 2, 3, 4]);
  }
});
