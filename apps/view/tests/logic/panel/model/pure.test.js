/** The Agents drawer selects work from prepared observations and renders without browser or clock reads. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsPanelModel } from '../../../../src/logic/panel/model.js';
import { shoutsModel } from '../../../../src/logic/panel/model.js';
import { agentsPanelHtml } from '../../../../src/logic/panel/render.js';
import { shoutsHtml } from '../../../../src/logic/panel/render.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const agent = (agentId, lastMoveAt = null) => ({ agentId, name: agentId, nameHtml: agentId,
  faceHtml: '<span class="avatar">' + agentId + '</span>', tipHtml: 'tip ' + agentId,
  markClasses: ' h1', ageHtml: lastMoveAt ? '<time>recent</time>' : '', lastMoveAt });
const item = (id, values = {}) => ({ id, status: 'open', state: 'open', stale: false, titleTextHtml: 'item ' + id,
  titleHtml: '<b>item ' + id + '</b>', stateHtml: '<span class="chip">open</span>', briefStateHtml: '<span class="chip">open</span>', ...values });

test('Agents selection preserves holding rank, recent filtering, picked idle expansion and actions [N26]', () => {
  const agents = [agent('builder'), agent('reviewer'), agent('idle', new Date(now - 30 * 60_000).toISOString()), agent('quiet', new Date(now - 2 * 60 * 60_000).toISOString())];
  const items = [
    item(1, { status: 'claimed', state: 'building', holder: 'builder' }),
    item(2, { status: 'submitted', state: 'verify', builtBy: 'builder', reviewer: 'reviewer' }),
    item(3, { state: 'back', builtBy: 'builder', stale: true }),
  ];
  const original = structuredClone({ agents, items });
  const panel = agentsPanelModel({ agents, items, now, activeAgent: 'idle', allAgents: false, idleOpen: false });
  assert.deepEqual(panel.busy.find(row => row.agentId === 'builder').holding.map(row => row.id), [1, 3, 2],
    'claimed work remains first, then sent-back or stale work, then other held work');
  assert.equal(panel.busy.find(row => row.agentId === 'reviewer').holding[0].id, 2);
  assert.ok(panel.idle.some(row => row.agentId === 'idle'), 'a recently active agent with no work stays in the recent list');
  assert.ok(!panel.listed.some(row => row.agentId === 'quiet'), 'an old idle agent stays out of the default list');
  const invalidClock = agentsPanelModel({ agents: [agent('future', new Date(now + 365 * 24 * 60 * 60_000).toISOString())], items: [], now: Infinity });
  assert.equal(invalidClock.listed.length, 0, 'non-finite now never admits an idle agent by recency');
  assert.equal(panel.idleOpen, true, 'picking an idle agent opens its fold');
  assert.equal(panel.showAll, true);
  assert.deepEqual({ agents, items }, original, 'selection does not mutate the board observations');
  const all = agentsPanelModel({ agents, items, now, allAgents: true });
  assert.equal(all.listed.length, 4);
  const html = agentsPanelHtml(panel, { now, dashboardHref: '/dashboard' });
  assert.match(html, /data-agent="builder"/u);
  assert.match(html, /data-agent="idle"/u);
  assert.match(html, /show all 4/u);
  assert.doesNotMatch(agentsPanelHtml(all, { now, dashboardHref: '/dashboard' }), /show only agents at work/u, 'the show-only choice appears only inside the open idle fold');
  const allOpen = agentsPanelModel({ agents, items, now, allAgents: true, idleOpen: true });
  assert.match(agentsPanelHtml(allOpen, { now, dashboardHref: '/dashboard' }), /show only agents at work/u);
});

const DAY = 864e5;
const today = Date.parse('2026-11-13T00:00:00Z');
const isoAt = (ms) => new Date(ms).toISOString();
const shoutOf = (id, from, ms, values = {}) => ({ id, from, to: 'person', at: isoAt(ms), ms, text: 'words ' + id, decision: false, answers: null, item: null, ...values });
const itemFacts = { 613: { title: 'An open view page survives a restart', chip: { tone: 'b', label: 'Building' }, href: '/items/613' }, 4698: { title: 'Move the codegen test', chip: { tone: 'l', label: 'Landed' }, href: '/items/4698' } };
const format = { clock: (iso) => iso.slice(11, 16), ago: () => '1m', day: (iso) => iso.slice(5, 10), startOfToday: today };
const feedMessages = [
  shoutOf(1, 'coordinator', today - 2 * DAY, { item: '4698', decision: true, text: 'needs an independent reviewer' }),
  shoutOf(2, 'coordinator', today + 36e5, { item: '613', text: 'main moved to abc; conflicts in apps/x.js' }),
  shoutOf(3, 'coordinator', today + 72e5, { item: '613', text: 'gate red at abc: static GATE_RED' }),
  shoutOf(4, 'sentinel', today + 9e6, { text: 'waits: 1 over budget' }),
  shoutOf(5, 'person', today + 1e7, { to: 'coordinator', item: '613', text: 'on it' }),
  shoutOf(6, 'core-3546', today - DAY, { item: '9', text: 'older thread' }),
];
const shoutsView = (values = {}) => shoutsModel({ messages: feedMessages, openIds: [1], personAskIds: [1], items: itemFacts, startOfToday: today, seen: { base: today, read: {} }, ...values });

test('clause 1: a thread is one row with its messages and a reply box only while it is open, and one thread opens at a time [N26]', () => {
  const closed = shoutsHtml(shoutsView(), format);
  assert.equal([...closed.matchAll(/class="sx-th[ "]/gu)].length, 3, 'one row per thread today: the ask, #613 and the notices; the older #9 is folded');
  assert.doesNotMatch(closed, /class="sx-tp"|class="sx-reply"/u, 'no thread is open');
  assert.match(closed, /data-shout-thread="item:613"[^>]*aria-expanded="false"/u);
  const opened = shoutsHtml(shoutsView({ openKey: 'item:613' }), format);
  assert.equal([...opened.matchAll(/class="sx-tp"/gu)].length, 1, 'exactly one open thread');
  assert.match(opened, /data-shout-thread="item:613"[^>]*aria-expanded="true"/u);
  assert.match(opened, /<form class="sx-reply" data-reply="item:613"><i class="sx-si you"><\/i><input[^>]*placeholder="Reply on #613"/u, 'the reply box is inside the thread');
  assert.match(opened, /<button class="sx-xb" type="button" data-shout-thread=""/u, 'a close control, besides Esc and a second click');
  assert.equal(shoutsView({ foundId: 3 }).openKey, 'item:613', 'an address that names a shout opens its thread');
  const long = Array.from({ length: 25 }, (_, n) => shoutOf(100 + n, 'core-1', today + 36e5 + n, { item: '613', text: 'note ' + n }));
  const folded = shoutsHtml(shoutsModel({ messages: long, items: itemFacts, startOfToday: today, openKey: 'item:613' }), format);
  assert.equal([...folded.matchAll(/class="sx-msg[ "]/gu)].length, 12, 'a long thread shows its latest twelve messages');
  assert.match(folded, /data-fold="msgs:item:613"[^>]*>13 earlier messages<\/button>/u, 'and one line for the rest');
  assert.equal([...shoutsHtml(shoutsModel({ messages: long, items: itemFacts, startOfToday: today, openKey: 'item:613', foundId: 100 }), format).matchAll(/class="sx-msg[ "]/gu)].length, 25, 'an addressed shout opens the whole thread');
  assert.match(shoutsHtml(shoutsView({ openKey: 'item:613' }), { ...format, readOnly: true }), /class="sx-tp"/u);
  assert.doesNotMatch(shoutsHtml(shoutsView({ openKey: 'item:613' }), { ...format, readOnly: true }), /sx-reply/u, 'a read-only page never offers a reply');
});

test('clause 2: asks for the person sit first, unread is bold from the viewer mark, automated notices are muted, each row has stage, sender and kind [N26]', () => {
  const view = shoutsView({ seen: { base: today + 5e6, read: {} } });
  assert.deepEqual(view.needs.map((thread) => thread.key), ['item:4698'], 'the ask waiting on the person');
  assert.ok(!view.threads.some((thread) => thread.key === 'item:4698'), 'an ask is not listed twice');
  const html = shoutsHtml(view, format);
  assert.ok(html.indexOf('Needs your answer') < html.indexOf('>Threads<'), 'asks first');
  assert.match(html, /<span class="sx-act">Answer<\/span>/u);
  assert.match(html, /<span class="sx-mk ruling">Ruling<\/span>/u);
  assert.match(html, /<span class="sx-chip l">Landed<\/span>/u);
  assert.match(html, /<span class="sx-snd coord"><i class="sx-si coord">/u, 'the coordinator has its own icon');
  const thread = (key) => [...view.needs, ...view.threads, ...view.earlier.threads].find((entry) => entry.key === key);
  assert.equal(thread('item:613').unread, false, 'the person spoke last, so it is read');
  assert.equal(thread('none').unread, true, 'a notice newer than the mark is unread');
  assert.equal(thread('none').quiet, true, 'an automated notice is muted');
  assert.match(html, /class="sx-th unread quiet"/u);
  assert.match(html, /<span class="sx-ud" role="img" aria-label="unread">/u);
  const read = shoutsView({ seen: { base: today + 5e6, read: { none: today + 99e5 } } });
  assert.equal([...read.threads].find((entry) => entry.key === 'none').unread, false, 'opening a thread moves its own mark');
  assert.equal(shoutsView({ seen: { base: null, read: {} } }).since.unread, 0, 'with no mark yet nothing is unread');
  assert.match(html, /Since you left <time class="long"[^>]*>1m<\/time>: <b>1<\/b> thread with new shouts · <span class="amb">1 ask<\/span> waits for your answer/u);
  assert.match(html, /data-mark-read/u);
});

test('clause 3: older days fold into one Earlier row, and the agents rail is one line per agent with sent back first and idle folded [N26]', () => {
  const view = shoutsView();
  assert.deepEqual(view.earlier.threads.map((thread) => thread.key), ['item:9'], 'everything older than today');
  const closed = shoutsHtml(view, format);
  assert.match(closed, /<button class="sx-dayrule" type="button" data-fold="earlier" aria-expanded="false"[^>]*><span>Earlier<\/span><span class="f">1 thread · 11-12<\/span>/u);
  assert.ok(!closed.includes('older thread'), 'folded rows are not drawn');
  assert.match(shoutsHtml(shoutsView({ folded: true }), format), /id="shouts-earlier"><button class="sx-th/u);
  assert.equal(shoutsView({ openKey: 'item:9' }).earlier.open, true, 'opening a thread inside the fold shows it');
  const agent = (agentId, holding, extra = {}) => ({ agentId, nameHtml: agentId, modelHtml: 'Sonnet', ageHtml: '<time data-ago="x">3m</time>', lastMoveAt: isoAt(today), holding, ...extra });
  const held = (id, state, status = 'claimed') => ({ id, state, status, titleTextHtml: 'title ' + id, since: isoAt(today - 3 * 36e5), ageHtml: '<time data-ago="y">3h</time>' });
  const busy = [agent('core-1', [held(1, 'building')]), agent('core-2', [held(2, 'back', 'open'), held(3, 'building')]), agent('core-3', [held(4, 'verify', 'submitted')])];
  const rail = agentsPanelHtml({ listed: busy, busy, idle: [agent('view-9', []), agent('view-8', [])], idleOpen: false, activeAgent: null, allAgents: false, totalAgents: 5, showAll: false, emptyText: '' }, { now: today, dashboardHref: '/dashboard' });
  assert.ok(rail.indexOf('Sent back') < rail.indexOf('Building') && rail.indexOf('Building') < rail.indexOf('In review'), 'sent back first');
  assert.equal([...rail.matchAll(/class="sx-ag /gu)].length, 3, 'one line per agent');
  assert.match(rail, /<code>#2<\/code>title 2<\/span><span class="sx-more">\+1<\/span><code class="sx-seat">core-2<\/code>/u, 'the held item, +n, the seat');
  assert.match(rail, /<time class="late" data-ago="y">3h<\/time>/u, 'a long wait is red');
  assert.match(rail, /<b>2<\/b> idle/u);
  assert.doesNotMatch(rail, /view-9/u, 'idle agents are folded');
  assert.match(rail, /<span class="cap2">3 holding work<\/span>/u);
});
