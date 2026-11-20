/** The Dashboard's Release card matches the approved mockup [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';

const now = Date.parse('2026-11-12T18:00:00Z');
const until = new Date(now + 30 * 60_000).toISOString();
const at = minutes => new Date(now - minutes * 60_000).toISOString();

/** A board with one release in progress: two items building, one in review and the release's counts from the API. */
function board() {
  const items = [
    { id: 11, title: 'Builds the hero', status: 'claimed', lane: 'view', claim: { by: 'view-1', until }, updatedAt: at(14) },
    { id: 12, title: 'Builds the flow', status: 'claimed', lane: 'view', claim: { by: 'view-2', until }, updatedAt: at(30) },
    { id: 13, title: 'Checks the tiles', status: 'submitted', lane: 'view', reviewer: 'tests-1', reviewUntil: until, updatedAt: at(9) },
  ];
  const events = [
    { event_id: 1, event_kind: 'claim', item_id: 11, event_by: 'view-1', event_at: at(14), event_detail: JSON.stringify({ leaseUntil: until }) },
    { event_id: 2, event_kind: 'claim', item_id: 12, event_by: 'view-2', event_at: at(30), event_detail: JSON.stringify({ leaseUntil: until }) },
    { event_id: 3, event_kind: 'submit', item_id: 13, event_by: 'view-3', event_at: at(9), event_detail: '{}' },
  ];
  const summary = { total: 152, left: 126, landed: 26, landing: 1, review: 11, building: 7, waiting: 98, held: 9,
    pace: { last6h: 12, last2h: 6, last24h: 30 }, estimate: { low: 42, high: 63 } };
  const project = { items, events, sequence: events.length, agents: ['view-1', 'view-2', 'tests-1'].map(agent_id => ({ agent_id })),
    milestones: [{ name: '0.9.4: Restructure for Speed and Cost', shipped: false, summary: { ...summary }, items: items.map(item => ({ id: item.id })) }] };
  return { project, events };
}

/** The rendered Release section. */
function shipping(html) {
  const start = html.indexOf('aria-label="Release"');
  assert.notEqual(start, -1, 'Release renders');
  return html.slice(start, html.indexOf('</section>', start));
}

test('view.x-render-dashboard-shipping.clause-1-shipping-now-the-release-name: clause 1: SHIPPING NOW, the release name in the body face, N to go · M of T landed, one stage bar and its legend in the stage colours [N26]', () => {
  const { project, events } = board();
  const card = shipping(dashboardHtml(dashboardModel(project, events, { now, complete: true }), { locale: 'en-US', timeZone: 'UTC' }));
  assert.match(card, /^aria-label="Release"><div class="dash-shd"><h2 class="dash-lbl">Release<\/h2><button type="button" class="dash-lk" data-tab="roadmap">Roadmap ›<\/button><\/div><div class="dash-card dash-ship"><div class="dash-ship-head">/u, 'the Release header sits above the card, with its way to the Roadmap (sheet v1.1)');
  assert.match(card, /<p class="dash-ship-name"><span class="dash-ver">0\.9\.4<\/span>Restructure for Speed and Cost<\/p>/u,
    'the version is faint and the name is a sentence-case paragraph, not a mono capital heading');
  assert.doesNotMatch(card, /class="release-name|roadmap-left|release-header/u, 'the shared Roadmap header with its mono capitals is not used here');
  assert.match(card, /<p class="dash-togo"><b><button type="button" class="dash-n " data-dashboard-list="next">126 to go<\/button><\/b><span>26 of 152 landed<\/span><\/p>/u);
  assert.equal([...card.matchAll(/<svg class="dash-sbar"/gu)].length, 1, 'one stage bar');
  assert.deepEqual([...card.matchAll(/data-release-segment="(\w+)" data-count="(\d+)"/gu)].map(([, key, n]) => [key, Number(n)]),
    [['landed', 26], ['landing', 1], ['review', 11], ['building', 7], ['waiting', 98], ['held', 9]], 'segments in stage order, sized by their counts');
  assert.deepEqual([...card.matchAll(/data-dashboard-list="([\w-]+)"><i class="dash-sw dash-seg-(\w+)"><\/i><b>(\d+)<\/b> ([^<]+)<\/button>/gu)].map(([, list, key, n, label]) => [key, n, label, list]),
    [['landed', '26', 'landed', 'landed'], ['landing', '1', 'landing', 'passed'], ['review', '11', 'in review', 'review'], ['building', '7', 'building', 'building'], ['waiting', '98', 'blocked', 'gated'], ['held', '9', 'held', 'held']],
    'the legend sits directly under the bar, one swatch per segment, each opening its list');
  assert.ok(card.indexOf('dash-sbar') < card.indexOf('dash-keys') && card.indexOf('dash-keys') < card.indexOf('dash-inflight'));
});

test('view.x-render-dashboard-shipping.clause-2-in-flight-shows-building-and: clause 2: In flight shows Building and In review side by side as one-line rows with no pills, then three pace tiles [N26]', () => {
  const { project, events } = board();
  const card = shipping(dashboardHtml(dashboardModel(project, events, { now, complete: true }), { locale: 'en-US', timeZone: 'UTC' }));
  assert.match(card, /<div class="dash-inflight">[\s\S]*?<h3 class="dash-ct">In flight<button type="button" class="dash-n dash-pill" data-dashboard-list="active">3<\/button>[\s\S]*?<div class="dash-ifcols"><div class="dash-ifcol building">/u, 'two columns, Building first');
  assert.match(card, /<div class="dash-ifcol review"><h3 class="dash-ifh"><svg[^]*?<\/svg>In review<button type="button" class="dash-n dash-faint" data-dashboard-list="review">1<\/button><\/h3>/u);
  const rows = [...card.matchAll(/<button type="button" class="dash-row" data-go="item:(\d+)"><span class="dash-id">#\1<\/span><span class="dash-t" title="[^"]*">([^<]+)<\/span><span class="dash-age">([^<]+)<\/span><\/button>/gu)]
    .map(([, id, title, holder]) => [Number(id), title, holder]);
  assert.deepEqual(rows, [[11, 'Builds the hero', 'view-1 · 14m'], [12, 'Builds the flow', 'view-2 · 30m'], [13, 'Checks the tiles', 'tests-1 · 9m']],
    'each row: id, title, then who holds it and for how long, on one line');
  assert.doesNotMatch(card, /item-stage|stage-word|stage-mark|class="pill|dash-chip/u, 'no status pills in the rows');
  const tiles = [...card.matchAll(/data-dashboard-tile="(\w+)"><span class="dash-stat-k"><svg[^]*?<\/svg>([^<]+)<\/span><span class="dash-stat-v"><b>([^<]+)<\/b>(?:<span>([^<]+)<\/span>)?<\/span><small>([^<]+)<\/small>/gu)]
    .map(([, key, label, value, unit, note]) => [key, label, value, unit ?? '', note]);
  assert.deepEqual(tiles, [
    ['today', 'Today’s pace', '2.0', 'items an hour', '12 landed in the last 6 hours'],
    ['now', 'Right now', '3.0', 'items an hour', '6 landed in the last 2 hours'],
    ['eta', 'ETA', '42–63 h', '', 'Saturday, around 12:00 PM to Sunday 9:00 AM'],
  ]);
  assert.ok(card.indexOf('dash-inflight') < card.indexOf('dash-pace'), 'the tiles follow In flight');
});
