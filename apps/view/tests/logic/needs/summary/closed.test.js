/** Rulings starts closed: one quiet line when empty, otherwise two-line rows that open only when the person opens them [N26,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsPanelHtml } from '../../../../index.js';
import { needsPanelModel } from '../../../../index.js';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { dashboardData } from '../../../fixtures/cockpit/data.js';

/** One call of each kind the person is asked about, the focus batch that used to open itself included. */
const calls = [
  { kind: 'focus-approval-batch', id: 'focus-approval:0.9.4', ref: '0.9.4', text: '2 draft rows rest under 0.9.4 items', at: '2026-11-01T00:00:00Z',
    rows: [{ id: 'G1', kind: 'spec', text: 'Keep one.', items: [10] }, { id: 'G2', kind: 'spec', text: 'Keep two.', items: [11] }] },
  { kind: 'decision', id: 7, ref: 'coordinator', text: 'Which wording ships?', at: '2026-11-02T00:00:00Z' },
  { kind: 'sentinel-draft', id: 's1', ref: 'file-size', check: 'node checks.js', directory: '.', every: 'hourly', owner: 'coordinator', at: '2026-11-03T00:00:00Z' },
  { kind: 'agent-approved', id: 'G3', agent: 'Sample Approver', approvedAt: '2026-11-04T00:00:00Z', commit: 'a'.repeat(40) },
  { kind: 'draft', count: 4 },
];
const project = { holds: [], items: [], spec: [{ id: 'G3', text: 'Keep three.', gate: 'test/g3.test.js' }] };
const opened = html => (html.match(/<details[^>]* open>/gu) || []).length;

test('every Rulings row is closed by default, in the full list and the Dashboard summary [N26,B26]', () => {
  for (const compact of [false, true]) {
    const model = needsPanelModel(calls, project, { person: true, compact });
    const html = needsPanelHtml(compact ? { ...model, headerSeparately: true } : model);
    assert.ok((html.match(/class="needs-call/gu) || []).length >= 3, 'each call renders as a row');
    assert.equal(opened(html), 0, (compact ? 'Dashboard' : 'Items') + ' opens no row by default, the focus batch included');
    assert.match(html, /<summary><span class="needs-kind needs-kind-\w+" aria-hidden="true">[^<]+<\/span><span class="needs-copy"><b><span class="needs-id"[^>]*>[^<]*<\/span>[^<]+<\/b><small>[^<]+<\/small><\/span><span class="needs-side">[^]*?<span class="needs-action needs-action-\w+">[^<]+<\/span>/u,
      'a row is the Items shape: icon, mono id, title, one context line and a chip');
  }
});

test('only the rows the person opened render open, and closing one takes it back out [N26,B26]', () => {
  const batchKey = 'focus-approval-batch:focus-approval:0.9.4';
  const open = needsPanelHtml(needsPanelModel(calls, project, { person: true, expanded: [batchKey] }));
  assert.equal(opened(open), 1);
  assert.match(open, new RegExp('data-needs-key="' + batchKey + '"[^>]* open>'), 'the opened batch stays open');
  const closed = needsPanelHtml(needsPanelModel(calls, project, { person: true, expanded: [] }));
  assert.equal(opened(closed), 0, 'a closed batch is not reopened by its rows');
});

test('the top of Items is one quiet line when nothing needs the person, and rows otherwise [N26,B26]', () => {
  const empty = needsPanelHtml(needsPanelModel([], { holds: [] }, { person: true, quiet: true }));
  assert.match(empty, /^<li class="needs-quiet"><span class="needs-quiet-badge" aria-hidden="true"><svg[^]*?<\/svg><\/span><p><b>Nothing to rule on\.<\/b> <span class="needs-quiet-note">When a decision is yours, it shows up here and on your phone\.<\/span><\/p><\/li>$/u);
  assert.equal(needsPanelHtml(needsPanelModel([], { holds: [] }, { person: true })), '', 'callers that do not ask for the line get nothing');
  const busy = needsPanelHtml(needsPanelModel(calls, project, { person: true, quiet: true }));
  assert.doesNotMatch(busy, /Nothing to rule on/u, 'any call replaces the quiet line');
  assert.equal(opened(busy), 0);
});

test('the Dashboard draws no Rulings card; rulings live in the notch (#6847) [N26]', () => {
  const input = dashboardData({ populated: true });
  const model = dashboardModel(input.project, input.events, { now: input.clockBase, complete: true });
  for (const html of [dashboardHtml(model), dashboardHtml(model, { needs: '<li class="needs-call">row</li>' })]) {
    assert.doesNotMatch(html, /aria-label="Rulings"|needs-card|Nothing to rule on|needs-call/u);
  }
});
