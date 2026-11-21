/** The Flow panel draws its rows and idle seats as quiet one-line markup [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowPanelModel } from '../../../src/logic/panel/flow.js';
import { flowPanelHtml } from '../../../src/logic/panel/render.js';

const doc = { version: 1, release: '0.9.5', asOf: '2026-11-18T12:00:00Z',
  items: [{ id: 9, title: 'b', lane: 'view', cause: 'held', reason: 'coordinator' }, { id: 7, title: 'a', lane: 'core', cause: 'building <fast>', seat: 'core-1' }],
  idle: [{ seat: 'view-2', lane: 'view', reason: 'nothing eligible' }, { seat: 'core-3', lane: 'core', reason: 'gate busy' }], landings: { lastHour: 0, lastTwoHours: 1 } };

test('view.flow-panel-render.rows-one-line-each-in-order: flowPanelHtml draws one one-line row per unlanded item with its id and cause, in input order [N26]', () => {
  const html = flowPanelHtml(flowPanelModel(doc));
  const rows = html.match(/<div class="sx-fl">.*?<\/div>/gu);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('#9') && rows[0].includes('held'));
  assert.ok(rows[1].includes('#7') && rows[1].includes('building &lt;fast&gt;'), 'the cause is escaped');
  assert.ok(!/\n/u.test(html), 'no row wraps onto a second line');
});

test('view.flow-panel-render.idle-seats-on-one-line: flowPanelHtml lists every idle seat on a single line [N26]', () => {
  const html = flowPanelHtml(flowPanelModel(doc));
  const idle = html.match(/<div class="sx-fl sx-flidle">.*?<\/div>/gu);
  assert.equal(idle.length, 1);
  assert.ok(idle[0].includes('view-2') && idle[0].includes('nothing eligible') && idle[0].includes('core-3') && idle[0].includes('gate busy'));
});

test('view.flow-panel-render.empty-model-one-quiet-line-no-accent-border: an empty flow model renders one quiet empty line and no markup draws a left-edge accent border [N26]', () => {
  const empty = flowPanelHtml(flowPanelModel({ version: 1, release: null, asOf: '2026-11-18T12:00:00Z', items: [], idle: [], landings: { lastHour: 0, lastTwoHours: 0 } }));
  assert.equal(empty.match(/class="sx-empty"/gu).length, 1);
  assert.ok(!empty.includes('sx-fl"'), 'an empty model draws no rows');
  for (const html of [empty, flowPanelHtml(flowPanelModel(doc))]) assert.ok(!/border-left|sx-bk/u.test(html), 'no left-edge accent border in the markup');
});
