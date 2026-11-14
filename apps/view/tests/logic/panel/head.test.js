/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/dashboard.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/item/panel.css apps/view/src/logic/panel/item.js */
/** @pullboard-world-pin reads panel.css, which the server adds to main.css at its marker, to prove the rules the page ships. */
/** The Items detail panel is the approved one: a single header block, then one scroll of sections in the approved order, each only when it has content [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeViewStyles } from '../../../src/io/styles.js';
import { itemPanelHtml } from '../../../src/logic/panel/item.js';
import { itemPanelModel } from '../../../src/logic/panel/item.js';
import { pageRenderScript } from '../../../src/io/page/render.js';

const css = composeViewStyles() + '\n' + readFileSync(new URL('../../../src/io/item/panel.css', import.meta.url), 'utf8');
const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const NOW = Date.parse('2026-11-13T23:25:00Z');
const base = { now: NOW, esc, name: seat => seat, stage: 'Ready', milestone: '0.9.4-UI Screens Match Their Mockups', reason: code => String(code).toLowerCase().replaceAll('_', ' '),
  brief: '', files: [], baseline: { label: 'no baseline on main', warn: false }, historyOpen: false };
const helpers = { esc, rich: text => esc(text), hash: value => '<code>' + esc(value) + '</code>', title: 'A title', note: 'The note', inline: text => esc(text), timeline: '<ol></ol>' };
const move = (kind, at, by, detail = {}) => ({ type: 'move', kind, at, by, detail, eventId: Date.parse(at) });
const draw = (item, extra = {}) => itemPanelHtml(itemPanelModel(item, { ...base, ...extra }), helpers);
const ready = { id: 7547, lane: 'view', route: 'strong', status: 'open', criterion: '1. The header is clean [test]. 2. The rail lists releases only [test].', thread: [move('add', '2026-11-13T23:19:00Z', 'coordinator')], verdicts: [], proofReceipts: [] };
const sentBack = { id: 4742, lane: 'core', route: 'mid', status: 'claimed', claim: { by: 'core-3528' }, check: 'node packages/gate/src/io/run/tests.js apps/cli/journeys/merged/proof.test.js',
  criterion: '1. merged --forced lands unproven [test]. 2. A queue lists unproven landings [test].',
  verdict: { decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', by: 'core-1551', at: '2026-11-12T15:53:28Z', commit: '3522c90e65c3' },
  verdicts: [{ decision: 'REJECT' }],
  proofReceipts: [{ kind: 'check', exitCode: 0, seat: 'core-3531', commit: 'cf7ffc928b12795856', at: '2026-11-13T22:23:00Z' }],
  thread: [move('add', '2026-11-09T19:35:00Z', 'coordinator'), move('claim', '2026-11-09T20:00:00Z', 'core-3513'), move('submit', '2026-11-12T15:52:00Z', 'core-2592', { commit: '3522c90e65c3' }),
    move('reject', '2026-11-12T15:53:28Z', 'core-1551', { reason: 'BEHAVIOR_MISMATCH' }), move('claim', '2026-11-13T23:06:00Z', 'core-3528'),
    { type: 'fact', kind: 'measurement', by: 'coordinator', at: '2026-11-13T22:42:00Z', text: 'Gate job gate:4742:cf7ffc928b12:x red at cf7ffc928b12; failing parts:\nproof not ok: packages/store/tests/milestone/limit.test.js :: a milestone with a limit refuses an add (shard a)\nproof not ok: packages/store/tests/next.test.js :: next answers fast (shard b)\nproof not ok: apps/cli/tests/moves.test.js :: submit posts (shard c)\nproof not ok: a/b.test.js :: four\nproof not ok: a/c.test.js :: five' }] };
const landed = { id: 6661, lane: 'view', route: 'strong', status: 'verified', merged: '2568569ebc936d', criterion: '1. The export exits 0 [command]. 2. Export reads in batches [test].',
  verdict: { decision: 'ACCEPT', reason: 'CRITERION_MET', by: 'core-2910', at: '2026-11-13T00:40:00Z', commit: '8cdece886dea' }, verdicts: [{ decision: 'ACCEPT' }], proofReceipts: [],
  thread: [move('add', '2026-11-12T23:13:00Z', 'coordinator'), move('claim', '2026-11-12T23:14:00Z', 'view-479'), move('submit', '2026-11-13T00:39:00Z', 'view-479', { commit: '8cdece886dea' }),
    move('accept', '2026-11-13T00:40:00Z', 'core-2910', { reason: 'CRITERION_MET' }), move('merged', '2026-11-13T00:57:00Z', 'coordinator', { commit: '2568569ebc936d' })] };
const ORDER = ['Sent back', 'Latest gate', 'Journey', 'Done when', 'Check', 'Brief', 'Files', 'History'];
const labels = html => [...html.matchAll(/<p class="ip-lbl">([^<]+)<\/p>/gu)].map(match => match[1]);

test('clause 1: the header is one block of id, stage chip with its sent-back mark, holder or landing commit, title and one quiet meta line, with no chip rows and no tabs [N26]', () => {
  const html = draw(sentBack, { stage: 'Building', milestone: '0.9.4 Restructure for Speed and Cost' });
  const head = html.slice(0, html.indexOf('</header>'));
  assert.match(head, /<span class="id">#4742<\/span><span class="ip-chip b">Building<\/span><span class="ip-mark"[^>]*>[\s\S]*<\/svg>1<\/span><span class="ip-who">core-3528 · /u, 'id, stage chip, sent-back mark, then the holder at the right');
  assert.match(head, /<h2>A title<\/h2><p class="ip-meta">core · mid · 0\.9\.4 Restructure for Speed and Cost<\/p>/u, 'the title, then one meta line of lane, route and milestone');
  assert.equal(head.includes('item-panel-where'), false, 'no chip rows');
  assert.equal(html.includes('role="tab"'), false, 'no tabs');
  assert.equal(html.includes('item-panel-tabs'), false);
  assert.match(draw(landed, { stage: 'Merged' }), /<span class="ip-chip l">Landed<\/span><span class="ip-who"><button class="hash-copy"[^>]*data-copy="2568569ebc936d"[^>]*><code class="inline sha"[^>]*>2568569ebc93<\/code><\/button> · \d+ Nov<\/span>/u, 'a landed item shows its landing commit and day at the right, with no sent-back mark');
  assert.match(draw(ready), /<span class="ip-who">added 6 m ago<\/span>/u, 'a ready item says when it was added');
  assert.equal(draw(ready, {}).includes('ip-mark'), false, 'no mark on an item that was never sent back');
  assert.match(css, /\.item-panel-head h2 \{[^}]*-webkit-line-clamp: 3/u);
});

test('clause 2: the panel is one scroll of sections in the approved order, each only when it has content, with Done when as one row per clause showing its evidence kind and proven state [N26]', () => {
  const full = draw({ ...sentBack, thread: [...sentBack.thread, move('merged', '2026-11-13T23:30:00Z', 'coordinator')].slice(0, -1) },
    { brief: 'Economics audit.', files: ['apps/a/src.js', 'apps/a/tests/src.test.js', 'x/1.js', 'x/2.js', 'x/3.js', 'x/4.js'], baseline: { label: 'no baseline on main', warn: false } });
  assert.deepEqual(labels(full), ORDER, 'the sections come in the approved order');
  assert.deepEqual(labels(draw(ready)), ['Done when', 'History'], 'a ready item shows only the sections that have content');
  assert.deepEqual(labels(draw({ ...ready, criterion: '', thread: [] })), [], 'an item with nothing recorded shows its header alone');
  assert.deepEqual(labels(draw(landed, { stage: 'Merged' })), ['Passed', 'Journey', 'Done when', 'History']);
  const rows = [...full.matchAll(/<div class="ip-cl"[^>]*><span class="n">(\d+)<\/span><span class="t">([^<]*)<\/span><span class="k">([^<]*)<\/span><span class="pv (\w+)"/gu)].map(match => match.slice(1));
  assert.deepEqual(rows, [['1', 'merged --forced lands unproven', 'test', 'run'], ['2', 'A queue lists unproven landings', 'test', 'run']], 'one row per clause: its text, its kind and its state');
  assert.match(full, /Run green<\/span>/u);
  assert.match(full, /3 more failed|2 more failed/u, 'a long gate list shows three failures and counts the rest');
  assert.deepEqual([...draw(ready).matchAll(/class="pv (\w+)"/gu)].map(match => match[1]), ['no', 'no'], 'a clause nobody ran is Not run');
  assert.deepEqual([...draw(landed, { stage: 'Merged' }).matchAll(/class="pv (\w+)"/gu)].map(match => match[1]), ['ok', 'ok'], 'a passed item proves its clauses');
  assert.match(draw(landed, { stage: 'Merged' }), /2 of 2 proven/u);
  assert.match(draw(ready), /0 of 2 proven/u);
  assert.equal(script().includes("'<div class=\"item-panel\">' + drawPanel(item)"), true, 'the arrived panel and the loading frame draw the same panel');
});

test('clause 2: the Done when rows, gate rows and history rows are one-line rows that never wrap, and a clause opens in place [N26]', () => {
  const rules = selector => [...css.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + ' \\{([^}]*)\\}', 'gu'))].map(match => match[1]).join(' ');
  assert.match(rules('.ip-row'), /white-space: nowrap/u);
  assert.match(rules('.ip-cl .t'), /white-space: nowrap/u);
  assert.match(rules('.ip-hr'), /white-space: nowrap/u);
  assert.match(rules('.ip-cl.open .t'), /white-space: normal/u, 'an opened clause shows its whole text');
  assert.match(rules('.ip-cl.open .ev'), /display: block/u, 'an opened clause shows its evidence');
  assert.doesNotMatch(css, /\.ip-[\w-]+ \{[^}]*box-shadow: 0 \d/u, 'no shadows on the panel');
});

/** The page script the view serves. */
function script() { return pageRenderScript(); }
