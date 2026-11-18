/** The item detail panel shows an item's typed fields and related items, and an item with neither is drawn as before [C7,#1321]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemPanelHtml } from '../../src/logic/panel/item.js';
import { itemPanelModel } from '../../src/logic/panel/item.js';

const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const base = { now: Date.parse('2026-11-16T12:00:00Z'), esc, name: seat => seat, stage: 'Ready', milestone: '', reason: code => String(code), brief: '', files: [], baseline: { label: 'none', warn: false }, historyOpen: false };
const helpers = { esc, rich: text => String(text).replace(/#(\d+)/gu, '<a href="#item-$1" data-go="item:$1">#$1</a>'), hash: value => '<code>' + esc(value) + '</code>', title: 'A title', note: '', inline: text => esc(text), timeline: '<ol></ol>' };
const plain = { id: 9361, lane: 'view', route: 'strong', status: 'open', criterion: '1. It shows [test]', thread: [{ type: 'move', kind: 'add', at: '2026-11-16T11:00:00Z', by: 'coordinator', detail: {}, eventId: 1 }] };
const draw = item => itemPanelHtml(itemPanelModel(item, base), helpers);

test('view.x-item-fields.clause-1-the-item-detail-panel-renders: clause 1: the item detail panel renders each set field as name, type and value, and each related item as a link to its detail [C7,#1321]', () => {
  const html = draw({ ...plain, fields: [{ name: 'points', type: 'number', value: 5 }, { name: 'size', type: 'choice', value: 'small' }], links: [{ id: 9355, title: 'Free link between items' }] });
  assert.match(html, /<div class="ip-row ip-fld" data-field="points"><b>points<\/b><span class="ip-cap">number<\/span><span>5<\/span><\/div>/u);
  assert.match(html, /data-field="size"><b>size<\/b><span class="ip-cap">choice<\/span><span>small<\/span>/u);
  assert.match(html, /data-related="9355"><a href="#item-9355" data-go="item:9355">#9355<\/a> <span>Free link between items<\/span>/u);
});

test('view.x-item-fields.clause-2-an-item-with-neither-fields: clause 2: an item with neither fields nor related items renders the panel unchanged [C7,#1321]', () => {
  const unchanged = draw(plain);
  assert.equal(draw({ ...plain, fields: [], links: [] }), unchanged);
  assert.doesNotMatch(unchanged, /item-panel-fields|item-panel-related|ip-lbl">(?:Fields|Related)/u);
});
