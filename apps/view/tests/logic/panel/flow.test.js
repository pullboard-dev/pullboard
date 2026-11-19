/** The Flow panel model has one row per unlanded item and lists idle seats [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowPanelModel } from '../../../src/logic/panel/flow.js';

test('view.flow-panel-model.one-row-per-item-and-idle-seat: flowPanelModel(doc) returns one row per entry of doc.items with its item id and cause, and one entry per doc.idle seat with its seat name and reason [N26]', () => {
  const doc = { version: 1, release: '0.9.5', asOf: '2026-11-18T12:00:00Z',
    items: [{ id: 7, title: 'a', lane: 'core', cause: 'building', seat: 'core-1' }, { id: 9, title: 'b', lane: 'view', cause: 'held', reason: 'coordinator' }],
    idle: [{ seat: 'view-2', lane: 'view', reason: 'nothing eligible' }], landings: { lastHour: 0, lastTwoHours: 1 } };
  const model = flowPanelModel(doc);
  assert.deepEqual(model.rows.map(row => [row.id, row.cause]), [[7, 'building'], [9, 'held']]);
  assert.deepEqual(model.idle.map(entry => [entry.seat, entry.reason]), [['view-2', 'nothing eligible']]);
});

test('view.flow-panel-model.empty-document-gives-empty-lists: flowPanelModel of a document with no items and no idle seats returns empty rows and an empty idle list [N26]', () => {
  const model = flowPanelModel({ version: 1, release: null, asOf: '2026-11-18T12:00:00Z', items: [], idle: [], landings: { lastHour: 0, lastTwoHours: 0 } });
  assert.deepEqual(model, { rows: [], idle: [] });
});
