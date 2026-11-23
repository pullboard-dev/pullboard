/** Render person controls from explicit advertised actions without a DOM or fake review [N26,B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentApprovalActionsHtml } from '../../../src/logic/needs/actions.js';
import { needsActionsHtml } from '../../../src/logic/needs/actions.js';
import { plainNeedWords } from '../../../src/logic/needs/list.js';
import { needsPanelHtml } from '../../../src/logic/needs/panel.js';
import { needsPanelModel } from '../../../src/logic/needs/panel.js';
import { notchPreview } from '../../../src/logic/notch/preview.js';
import { notchPreviewData } from '../../../src/logic/notch/preview.js';
import { notchPreviewHtml } from '../../../src/logic/notch/preview.js';

test('view.needs-actions.approval-controls-require-exact-row-verbs-and: approval controls require exact row verbs and person authority on both detail surfaces [N26,B26,C7]', () => {
  const row = { id: 'G1', actions: [{ verb: 'spec-approve', args: { ids: 'G1' } }, { verb: 'spec-decline', args: { ids: 'G2' } }] };
  assert.equal(agentApprovalActionsHtml(row), '');
  const html = agentApprovalActionsHtml(row, { person: true, detail: true });
  assert.match(html, /detail-decision-actions/u);
  assert.match(html, /data-row-id="G1" data-row-decision="approve">Confirm/u);
  assert.doesNotMatch(html, /data-row-decision="decline"/u);
  assert.equal(agentApprovalActionsHtml({ ...row, actions: [{ verb: 'unrelated', args: { ids: 'G1' } }] }, { person: true }), '');
});

test('view.needs-actions.needs-action-rendering-keeps-revisions-exact-and: Needs action rendering keeps revisions exact and inspection-only calls inert [N26,B26,C7]', () => {
  const revision = { kind: 'spec-revision', id: 'G1', actions: [{ verb: 'spec-approve', args: { ids: 'G1' } }, { verb: 'spec-decline', args: { ids: 'G2' } }] };
  assert.match(needsActionsHtml(revision, { person: true }), /data-row-id="G1" data-row-decision="approve"/u);
  assert.doesNotMatch(needsActionsHtml(revision, { person: true }), /data-row-decision="decline"/u);
  assert.doesNotMatch(needsActionsHtml({ ...revision, actions: [] }, { person: true }), /<button/u);
  assert.equal(needsActionsHtml(revision), '');
  for (const kind of ['block', 'relay-health']) assert.equal(needsActionsHtml({ kind, target: 'do-not-navigate' }, { person: true }), '');
});

test('view.needs-actions.ordinary-needs-controls-retain-exact-targets-and: ordinary Needs controls retain exact targets and unmaterialized proposals stay non-actionable [N26,B26,C7]', () => {
  assert.match(needsActionsHtml({ kind: 'decision', id: 7 }, { person: true }), /data-go="decide:7">Decide/u);
  assert.match(needsActionsHtml({ kind: 'pending', id: 'G1' }, { person: true }), /data-go="spec:G1">Review/u);
  assert.match(needsActionsHtml({ kind: 'hold', id: 'view' }, { person: true }), /data-go="tab:shouts"/u);
  assert.equal(needsActionsHtml({ kind: 'rigor-draft', target: 'spec:G1', unproved: true }, { person: true }), '');
  assert.match(needsActionsHtml({ kind: 'rigor-draft', target: 'spec:G1', unproved: true, materialized: true }, { person: true }), /data-go="spec:G1"/u);
  assert.equal(needsActionsHtml({ kind: 'agent-approved' }, { person: false, approvalHtml: '<button>Prepared</button>' }), '');
  assert.equal(needsActionsHtml({ kind: 'agent-approved' }, { person: true, approvalHtml: '<button>Prepared</button>' }), '<button>Prepared</button>');
});

/** A stand-in DOM that is just enough for the notch controller: nodes, events, attributes and descendants. */
class Node {
  constructor(doc, attrs = {}, parent = null) { this.ownerDocument = doc; this.attrs = { ...attrs }; this.parent = parent; this.kids = []; this.on = {}; this.className = ''; this.innerHTML = ''; this.style = { setProperty() {} }; parent?.kids.push(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
  append(...n) { for (const x of n) { x.parent = this; this.kids.push(x); } } remove() { this.removed = true; }
  addEventListener(t, f) { (this.on[t] ||= []).push(f); } removeEventListener(t, f) { this.on[t] = (this.on[t] || []).filter(x => x !== f); }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  closest(sel) { const k = sel.match(/^\[([\w-]+)\]$/u)[1]; for (let x = this; x; x = x.parent) if (x.attrs && k in x.attrs) return x; return null; }
  querySelectorAll() { return this.kids.filter(k => 'data-notch' in k.attrs); }
  querySelector(sel) { const v = sel.match(/="(\w+)"/u)[1]; return this.kids.find(k => k.attrs['data-notch'] === v) ?? null; }
  getBoundingClientRect() { return { bottom: 34 }; }
  fire(type, event = {}) { for (const f of this.on[type] || []) f({ target: this, relatedTarget: null, ...event }); }
}

/** A notch over three rulings, its list open in the panel; the page's own data-go dispatch is the reader of whatever a click lands on. */
function openList() {
  const doc = new Node(null); doc.body = new Node(doc); doc.createElement = () => new Node(doc);
  const notch = new Node(doc); doc.body.append(notch);
  const widget = new Node(doc, { 'data-notch': 'rulings' }); notch.append(widget);
  const rulings = [
    { kind: 'spec', title: 'Draft rows', cls: 'Spec', thing: 'Spec', action: 'Review', go: 'tab:spec' },
    { kind: 'item', title: 'Decision', cls: 'Decision', thing: '#7', action: 'Decide', go: 'decide:7' },
    { kind: 'rigor', title: 'Consider splitting src/board.js', cls: 'Rigor', thing: 'RG498791', action: 'Review', go: 'spec:RG498791' },
  ];
  const data = notchPreviewData({ floor: { numbers: {}, time: {}, bins: [] }, rulings, oldest: '' });
  const controller = notchPreview(notch, () => data, { setTimer: () => 0, clearTimer: () => {} });
  const [, panel] = doc.body.kids.slice(1);
  controller.list();
  // The list's own markup, one stand-in node per row carrying exactly the attributes the markup gives it.
  const html = notchPreviewHtml(data, 'list');
  const rows = [...html.matchAll(/<div class="np-d"([^>]*)>/gu)].map(match => Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/gu)].map(pair => [pair[1], pair[2]])));
  const nodes = rows.map(attrs => new Node(doc, attrs, panel));
  return { controller, panel, nodes, rulings, dispatched: target => target.closest('[data-go]')?.getAttribute('data-go') ?? null };
}

test('view.needs-actions.ruling-row-body-opens-it: clause 1: a click on the body of the third ruling row opens that ruling, the same target as its own Review button, where its Approve and Decline controls are [N26,B26,C7]', () => {
  const { panel, nodes, rulings, dispatched, controller } = openList();
  assert.equal(nodes.length, 3);
  const body = new Node(panel.ownerDocument, {}, nodes[2]);
  assert.equal(dispatched(body), 'spec:RG498791', 'a click on the row body reaches the third ruling\'s own target');
  assert.equal(dispatched(body), rulings[2].go, 'the same target its Review button carries');
  assert.equal(dispatched(new Node(panel.ownerDocument, {}, nodes[0])), 'tab:spec', 'each row opens its own ruling, not the first');
  // The ruling's Approve and Decline controls are drawn on the page the target opens, for exactly that ruling.
  const detail = needsActionsHtml({ kind: 'rigor-draft', target: 'spec:RG498791', unproved: true, materialized: true }, { person: true });
  assert.match(detail, /data-go="spec:RG498791"/u);
  assert.equal(controller.state().mode, 'list');
});

test('view.needs-actions.choosing-a-ruling-closes-the-list: clause 2: choosing a ruling, by its row or its button, closes the open Rulings list so the chosen ruling is visible [N26,B26,C7]', () => {
  const chosen = openList();
  assert.equal(chosen.controller.state().mode, 'list');
  chosen.panel.fire('click', { target: new Node(chosen.panel.ownerDocument, {}, chosen.nodes[2]) });
  assert.deepEqual(chosen.controller.state(), { open: null, mode: null }, 'a click on the row body closes the list');
  const button = openList();
  button.panel.fire('click', { target: new Node(button.panel.ownerDocument, { 'data-go': 'spec:RG498791' }, button.nodes[2]) });
  assert.deepEqual(button.controller.state(), { open: null, mode: null }, 'a click on the Review button closes the list');
});

test('view.needs-actions.rigor-draft-text-is-decoded: clause 3: a Rigor draft whose source text holds percent-encoded characters renders as decoded plain words in the ruling detail [N26,B26,C7]', () => {
  const source = 'rigor-auto:' + encodeURIComponent(JSON.stringify({ version: 1, unproved: true, key: 'refusal:CONFLICT', evidence: { occurrences: 3 } }));
  assert.match(source, /%22/u, 'the producer\'s source token is percent-encoded');
  const call = { kind: 'rigor-draft', ref: 'RG498791', text: 'Rigor draft: Consider splitting src/board.js into independently owned modules. Source: ' + source, what: 'Approve or Decline', target: 'spec:RG498791', unproved: true };
  const html = needsPanelHtml(needsPanelModel([call], {}, { person: true }));
  assert.doesNotMatch(html, /%22|%7B|%2C/u, 'no percent-encoded character reaches the detail');
  assert.match(html, /unproved/u);
  assert.match(html, /refusal:CONFLICT/u);
  assert.match(html, /Consider splitting src\/board\.js/u);
  assert.equal(plainNeedWords({ kind: 'decision', text: 'ask 100% now' }).text, 'ask 100% now', 'a text that is not a Rigor source is left alone');
  assert.equal(plainNeedWords({ kind: 'rigor-draft', text: 'Source: rigor-auto:%E0%A4%A' }).text, 'Source: rigor-auto:%E0%A4%A', 'a token that cannot be decoded stays as it was');
});
