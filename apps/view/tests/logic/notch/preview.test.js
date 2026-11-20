/** The notch preview: data in, markup out, and the hover, click and Esc behaviour on a stand-in notch [N26,#6651]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notchPreview } from '../../../src/logic/notch/preview.js';
import { notchPreviewData } from '../../../src/logic/notch/preview.js';
import { notchPreviewHtml } from '../../../src/logic/notch/preview.js';
import { notchRulings } from '../../../src/logic/notch/preview.js';
import { notchFloor } from '../../../src/logic/notch/preview.js';

const floor = { numbers: { live: 62, building: 43, reviewing: 6, between: 11, landed: 636, sentBack: 6 },
  time: { build: 65, review: 14, idle: 21 }, bins: Array.from({ length: 24 }, (_, i) => ({ count: i === 23 ? 5 : i + 1 })) };
const rulings = [
  { kind: 'spec', title: 'Review', cls: 'Spec', thing: '10 draft rows', action: 'Review', go: 'tab:spec' },
  { kind: 'item', title: 'Approve', cls: 'Item', thing: '#6604 new spec row', action: 'Approve', go: 'item:6604' },
  { kind: 'rigor', title: 'Decide', cls: 'Rigor', thing: 'split src/board.js', action: 'Decide', go: 'decide:1' },
  { kind: 'ship', title: 'Cut', cls: 'Release', thing: '0.9.4 ready to cut', action: 'Cut', go: 'tab:roadmap' },
  { kind: 'item', title: 'Approve', cls: 'Item', thing: '#5771 schema bump', action: 'Approve', go: 'item:5771' },
];
const data = notchPreviewData({ floor, rulings, oldest: '3 h' });

test('view.notch-preview.agents-preview-agent-time-split-bar-its: agents preview: agent-time split bar, its key and the state rows [N26]', () => {
  const html = notchPreviewHtml(data, 'agents');
  assert.match(html, /<h4>Agents · 62 · agent time, last 4 h<\/h4>/u);
  assert.match(html, /class="np-split"/u);
  assert.match(html, /Building <b>65%<\/b>/u);
  assert.match(html, /Idle <b>21%<\/b>/u);
  assert.equal(html.match(/class="np-d"/gu).length, 3, 'building, reviewing and between items');
  assert.match(html, /<span class="np-val">43<\/span>/u);
  assert.doesNotMatch(html, /style=/u, 'the stylesheet policy refuses inline styles');
});

test('view.notch-preview.per-hour-preview-24-landed-per-hour: per-hour preview: 24 landed-per-hour bars with the last one marked now, and the pace rows [N26]', () => {
  const html = notchPreviewHtml(data, 'perHour');
  assert.equal(html.match(/<rect class="np-(bin|now|none)"/gu).length, 24);
  assert.equal(html.match(/np-now/gu).length, 1);
  assert.match(html, /<h4>Pace · 18\/h · landed per hour<\/h4>/u, 'the last six hours average (19+20+21+22+23+5)/6');
  assert.match(html, /Last 6 hours/u); assert.match(html, /Landed in 24 hours/u); assert.match(html, />636</u);
  assert.match(html, /np-val np-a">/u, 'a slowing last two hours reads amber');
});

test('view.notch-preview.rulings-preview-kind-bar-kind-key-and: rulings preview: kind bar, kind key and only the top three rulings; the list shows all with action buttons [N26]', () => {
  const html = notchPreviewHtml(data, 'rulings');
  assert.match(html, /<h4>Rulings · 5 · oldest waiting 3 h<\/h4>/u);
  assert.equal(html.match(/<rect class="np-f-/gu).length, 4, 'one segment per kind: spec, item, rigor, ship');
  assert.match(html, /Item <b>2<\/b>/u);
  assert.equal(html.match(/class="np-d"/gu).length, 3);
  assert.match(html, /data-notch-list>Open all 5 ›/u);
  const list = notchPreviewHtml(data, 'list');
  assert.equal(list.match(/class="np-d"/gu).length, 5);
  assert.equal(list.match(/<button class="np-act"/gu).length, 5, 'every ruling carries an action button');
  assert.match(list, /<span class="np-tx"><b>Approve<\/b><small><em>Item<\/em> · #6604 new spec row<\/small><\/span>/u, 'muted title, bold class, then the thing');
  assert.match(list, /data-go="item:6604"/u);
  assert.equal(notchPreviewHtml(data, 'nothing'), '');
  assert.match(notchPreviewHtml({ rulings: { items: [] } }, 'list'), /No rulings\./u);
});

test('view.notch-preview.board-text-is-escaped-and-the-data: board text is escaped and the data is never mutated [N26]', () => {
  const evil = { rulings: { items: [{ kind: 'item', title: '<b>x</b>', cls: 'A&B', thing: '"q"', action: '<i>', go: 'item:1' }] } };
  const before = structuredClone(evil);
  const html = notchPreviewHtml(evil, 'list');
  assert.doesNotMatch(html, /<b>x<\/b>|<i>/u);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/u);
  assert.deepEqual(evil, before);
});

/** A stand-in DOM that is just enough for the controller: nodes, events, attributes and descendants. */
class Node {
  constructor(doc, attrs = {}, parent = null) { this.ownerDocument = doc; this.attrs = { ...attrs }; this.parent = parent; this.kids = []; this.on = {}; this.className = ''; this.innerHTML = ''; this.style = { setProperty() {} }; }
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
function stage() {
  const doc = new Node(null); doc.body = new Node(doc); doc.createElement = () => new Node(doc);
  const notch = new Node(doc); doc.body.append(notch);
  const widgets = Object.fromEntries(['agents', 'perHour', 'rulings'].map(k => { const w = new Node(doc, { 'data-notch': k }); notch.append(w); return [k, w]; }));
  const timers = []; let now = 0;
  const setTimer = (f, ms) => { const t = { f, at: now + ms, live: true }; timers.push(t); return t; };
  const clearTimer = t => { if (t) t.live = false; };
  const tick = ms => { now += ms; for (const t of timers.filter(x => x.live && x.at <= now)) { t.live = false; t.f(); } };
  const reads = []; const ctl = notchPreview(notch, () => { reads.push(1); return data; }, { setTimer, clearTimer });
  const [veil, panel] = doc.body.kids.slice(1);
  return { doc, notch, widgets, tick, ctl, veil, panel, reads, body: doc.body };
}

test('view.notch-preview.hovering-a-widget-opens-one-panel-after: hovering a widget opens one panel after 160 ms, leaving closes it 180 ms later, with no new fetch [N26]', () => {
  const s = stage();
  s.notch.fire('mouseover', { target: s.widgets.agents });
  s.tick(159); assert.equal(s.ctl.state().open, null, 'not yet at 159 ms');
  s.tick(1); assert.deepEqual(s.ctl.state(), { open: 'agents', mode: 'preview' });
  assert.equal(s.panel.getAttribute('data-open'), 'true'); assert.equal(s.veil.getAttribute('data-open'), 'true');
  assert.match(s.panel.innerHTML, /Agents · 62/u);
  s.notch.fire('mouseout', { target: s.widgets.agents, relatedTarget: s.body });
  s.tick(179); assert.equal(s.ctl.state().open, 'agents', 'still open at 179 ms');
  s.tick(1); assert.equal(s.ctl.state().open, null); assert.equal(s.panel.getAttribute('data-open'), 'false');
  assert.equal(s.reads.length, 1, 'data came from the page state read once for the one panel');
});

test('view.notch-preview.moving-to-the-panel-keeps-it-open: moving to the panel keeps it open, and moving to another widget switches at once [N26]', () => {
  const s = stage();
  s.notch.fire('mouseover', { target: s.widgets.agents }); s.tick(160);
  s.notch.fire('mouseout', { target: s.widgets.agents, relatedTarget: s.panel }); s.tick(500);
  assert.equal(s.ctl.state().open, 'agents', 'the pointer is in the panel');
  s.notch.fire('mouseover', { target: s.widgets.perHour }); s.tick(0);
  assert.equal(s.ctl.state().open, 'perHour', 'no second 160 ms wait');
  assert.match(s.panel.innerHTML, /landed per hour/u);
});

test('view.notch-preview.clicking-rulings-opens-the-list-in-the: clicking rulings opens the list in the same panel; Esc closes it, and so does a click outside [N26]', () => {
  const s = stage();
  s.notch.fire('click', { target: s.widgets.rulings });
  assert.deepEqual(s.ctl.state(), { open: 'rulings', mode: 'list' });
  assert.equal(s.panel.innerHTML.match(/class="np-act"/gu).length, 5);
  assert.equal(s.body.getAttribute('data-notch-open'), 'list');
  s.notch.fire('mouseover', { target: s.widgets.agents }); s.tick(500);
  assert.equal(s.ctl.state().mode, 'list', 'hovering another widget does not replace the list');
  s.doc.fire('keydown', { key: 'Enter' }); assert.equal(s.ctl.state().open, 'rulings');
  s.doc.fire('keydown', { key: 'Escape' }); assert.equal(s.ctl.state().open, null);
  s.notch.fire('click', { target: s.widgets.rulings }); s.veil.fire('click');
  assert.equal(s.ctl.state().open, null, 'the blurred page outside the panel closes it');
});

test('view.notch-preview.the-preview-opens-the-list-from-open: the preview opens the list from "Open all", and an action or another widget click closes the panel [N26]', () => {
  const s = stage();
  s.notch.fire('mouseover', { target: s.widgets.rulings }); s.tick(160);
  const openAll = new Node(s.doc, { 'data-notch-list': '' }, s.panel);
  s.panel.fire('click', { target: openAll });
  assert.equal(s.ctl.state().mode, 'list');
  const action = new Node(s.doc, { 'data-go': 'item:6604' }, s.panel);
  s.panel.fire('click', { target: action });
  assert.equal(s.ctl.state().open, null, 'the page dispatches the action; the panel steps aside');
  s.notch.fire('mouseover', { target: s.widgets.agents }); s.tick(160);
  s.notch.fire('click', { target: s.widgets.agents });
  assert.equal(s.ctl.state().open, null, 'clicking a number goes to its page rather than staying previewed');
});

test('view.notch-preview.destroy-removes-the-panel-and-its-listeners: destroy removes the panel and its listeners [N26]', () => {
  const s = stage(); s.ctl.destroy();
  assert.ok(s.panel.removed && s.veil.removed);
  assert.equal(s.notch.on.mouseover.length, 0); assert.equal((s.doc.on.keydown || []).length, 0);
});

test('view.notch-preview.notchrulings-the-page-s-calls-become-list: notchRulings: the page\'s calls become list rows with the button the Needs panel gives, and the oldest waiting [N26,#6651]', () => {
  const calls = [{ kind: 'decision', id: 12, ref: 'agent-3', text: 'Split the board?\nmore', at: '2026-11-12T10:00:00.000Z' }, { kind: 'pending', id: 'S1.2', ref: 'S1.2', text: 'Pick one' }, { kind: 'draft', count: 4 }];
  const out = notchRulings(calls, row => row, iso => iso.slice(11, 13) + ' h');
  assert.equal(out.items.length, 3, 'the draft rows are one ruling, so the list agrees with the notch\'s count');
  assert.deepEqual([out.items[2].title, out.items[2].go], ['4 draft rows', 'tab:spec']);
  assert.deepEqual([out.items[0].title, out.items[0].action, out.items[0].go, out.items[1].go], ['Split the board?', 'Decide', 'decide:12', 'spec:S1.2']);
  assert.equal(out.oldest, '10 h');
});

test('view.notch-preview.notchfloor-the-notch-s-numbers-from-a: notchFloor: the notch\'s numbers from a Dashboard model, with the notch\'s own agents total [N26,#6651]', () => {
  const state = { now: 100, start: 0, complete: true, agents: [{ group: 'building', build: 50, review: 0 }, { group: 'reviewing', build: 0, review: 40 }, { group: 'between items', build: 10, review: 10 }, { group: 'quiet', build: 0, review: 0 }],
    totals: { day: 636, sentBack: 6 }, bins: [{ count: 2 }] };
  const out = notchFloor(state, 3);
  assert.deepEqual(out.numbers, { live: 3, building: 1, reviewing: 1, between: 1, landed: 636, sentBack: 6, pace: null });
  assert.deepEqual(out.time, { build: 60, review: 50, idle: 190 }, 'a quiet agent adds nothing and idle stays inside the window');
  const partial = notchPreviewHtml(notchPreviewData({ floor: { ...out, complete: false, numbers: { ...out.numbers, pace: { last2h: 4, last6h: 18, last24h: 70 } } } }), 'agents');
  assert.match(partial, /at work now/u, 'without full history the split shows who is working now, never a guessed time');
  assert.equal(out.bins.length, 1);
});
