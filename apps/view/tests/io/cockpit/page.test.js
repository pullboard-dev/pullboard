/** @pullboard-test-input apps/view/src/io/item/panel.css apps/view/src/io/main.css apps/view/src/io/dashboard.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/logic/panel/item.js */
/** @pullboard-world-pin reads panel.css, which the server adds to main.css at its marker, to prove the strip rules the page ships. */
/** The item page's Timeline strip: its markup from a timeline document, its read-only route on a real fixture board, and its hover text [C7,#12162]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readItemTimeline } from '../../../../../packages/stats/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';
import { serveView } from '../../../src/io/serve.js';
import { composeViewStyles } from '../../../src/io/styles.js';
import { itemPanelHtml } from '../../../src/logic/panel/item.js';
import { itemPanelModel } from '../../../src/logic/panel/item.js';
import { pageRenderScript } from '../../../src/io/page/render.js';

const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const NOW = Date.parse('2026-11-20T12:00:00Z');
const helpers = strip => ({ esc, rich: text => esc(text), hash: value => '<code>' + esc(value) + '</code>', title: 'A title', note: '', inline: text => esc(text), timeline: '<ol></ol>', strip });
const item = { id: 12162, lane: 'view', route: 'strong', status: 'claimed', claim: { by: 'view-987' }, criterion: '1. The strip draws [test].', thread: [] };
const panel = strip => itemPanelHtml(itemPanelModel(item, { now: NOW, esc, name: seat => seat, stage: 'Building', milestone: '0.9.5', reason: code => String(code), brief: '', files: [], baseline: { label: 'no baseline on main', warn: false }, historyOpen: false }), helpers(strip));
const S = 1000;
/** A timeline summary of 1000 s: building, waiting for runner, testing, a named wait and an UNACCOUNTED stretch. */
const summary = {
  total_ms: 1000 * S, gates: 1, unaccounted_ms: 90 * S, unaccounted_share: 0.09, unaccounted: [{ from: 1, to: 2, ms: 90 * S }], open_until: null,
  buckets: { building: 460 * S, 'waiting for runner': 100 * S, testing: 250 * S, 'waiting for review': 0, reviewing: 0, 'waiting to land': 0, landing: 0, rework: 0 },
  waits: { NO_RUNNER_SLOT: 100 * S, HELD: 0 },
  longest_gap: { from: 1, to: 2, ms: 100 * S, fromStage: 'gate-queued', toStage: 'gate-running', reason: 'NO_RUNNER_SLOT' },
};
const strip = { version: 1, item: 12162, rows: [], summary, unmapped: [] };
const segments = html => [...html.matchAll(/<rect class="tl-seg ([^"]+)"([^>]*?) data-stage="([^"]*)" data-ms="(\d+)" x="([\d.]+)" y="0" width="([\d.]+)" height="10"><title>([^<]*)<\/title><\/rect>/gu)]
  .map(match => ({ cls: match[1], attrs: match[2], stage: match[3], ms: Number(match[4]), width: Number(match[6]), title: match[7] }));

test('view.item.timeline-strip: clause 1: the item panel shows one strip whose segment widths match the bucket shares within 1%, the UNACCOUNTED stretch marked and the longest gap labelled with its reason [C7,#12162]', () => {
  const html = panel(strip);
  assert.equal((html.match(/<svg class="tl-strip"/gu) ?? []).length, 1, 'one strip');
  const found = segments(html);
  assert.deepEqual(found.map(segment => segment.stage), ['building', 'waiting for runner', 'testing', 'waiting', 'UNACCOUNTED']);
  for (const segment of found) assert.ok(Math.abs(segment.width / 10 - segment.ms / summary.total_ms * 100) < 1, `${segment.stage} is as wide as its share`);
  assert.equal(found.filter(segment => segment.attrs.includes('data-unaccounted="true"')).length, 1, 'the UNACCOUNTED stretch is marked');
  assert.match(html, /<p class="tl-gap" data-gap="NO_RUNNER_SLOT">longest gap 1m 40s NO_RUNNER_SLOT<\/p>/u, 'the longest gap names its reason');
  assert.ok(!/<svg class="tl-strip"[^>]*style=/u.test(html), 'no inline style');
  assert.ok(!panel(null).includes('tl-strip'), 'without a timeline document the panel draws no strip');
  const script = pageRenderScript();
  assert.ok(script.includes('/item-timeline/') && script.includes('strip: stripOf(item)'), 'the page script fetches the route and hands the strip to the panel');
});

test('view.item.timeline-strip-route: clause 2: the read-only route on a real fixture board answers the json pullboard timeline <id> --json prints [C7,#12162]', async t => {
  const project = cellProject(t, { real: true, gate: 'true' });
  let at = Date.parse('2026-11-20T10:00:00Z');
  const clock = { now: () => new Date(at) };
  const board = cellBoard(t, project.boardFile, clock, { real: true, gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'view', path: project.repo });
  const id = cellItem(board, { lane: 'view', title: 'Timeline strip item', route: 'mid', criterion: '1. It draws [test].', brief: 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n', check: 'true' }).item_id;
  at += 30_000;
  cellClaim(board, id, seat, { root: project.repo });
  at += 420_000;
  // The route runs the CLI it is given; this stand-in prints the document the timeline command prints, from the same reader and board.
  const runCommand = async (argv, { stdout }) => {
    const timeline = readItemTimeline(board, Number(argv[1]), { now: clock.now().getTime() });
    if (!timeline.rows.length) return 1;
    stdout.write(JSON.stringify({ version: 1, item: Number(argv[1]), rows: timeline.rows, summary: timeline.summary, unmapped: timeline.unmapped }));
    return 0;
  };
  const secret = ['strip', 'route', 'key', '0123456789'].join('-');
  const unused = () => { throw new Error('not used by the timeline route'); };
  const view = await serveView({ secret, projectRoot: project.repo, projects: () => [{ root: project.repo, name: 'Strip fixture' }], clock, runCommand, renderPage: () => '', refusalDocument: () => '', boardOpeners: { openBoard: unused, openBoardForRead: unused } });
  t.after(() => view.close());
  const answer = await fetch(`http://127.0.0.1:${view.port}/item-timeline/${id}`, { headers: { 'x-pullboard-key': secret } });
  assert.equal(answer.status, 200);
  const served = await answer.json();
  const direct = readItemTimeline(board, id, { now: clock.now().getTime() });
  assert.deepEqual(served, { version: 1, item: id, rows: direct.rows, summary: direct.summary, unmapped: direct.unmapped }, 'the route answers the timeline document');
  assert.deepEqual(served.rows.map(row => row.stage), ['filed', 'claimed']);
  assert.ok(served.summary.total_ms >= 450_000, 'the item has its stretch');
  assert.equal((await fetch(`http://127.0.0.1:${view.port}/item-timeline/${id + 900}`, { headers: { 'x-pullboard-key': secret } })).status, 404, 'an item with no events is 404');
  assert.equal((await fetch(`http://127.0.0.1:${view.port}/item-timeline/${id}`)).status, 403, 'the route needs the key');
});

test('view.item.timeline-strip-hover: clause 3: each segment carries its stage, length and reason as title text, and the strip rules use only colour tokens the view already defines [C7,#12162]', () => {
  const found = segments(panel(strip));
  assert.deepEqual(found.map(segment => segment.title), ['building 7m 40s', 'waiting for runner 1m 40s', 'testing 4m 10s', 'waiting 1m 40s NO_RUNNER_SLOT', 'UNACCOUNTED 1m 30s UNACCOUNTED']);
  const own = readFileSync(new URL('../../../src/io/item/panel.css', import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('.ip-tl'));
  assert.ok(own.length >= 8, 'the strip has its rules');
  const defined = composeViewStyles() + readFileSync(new URL('../../../src/io/item/panel.css', import.meta.url), 'utf8');
  for (const line of own) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/iu.test(line), `no colour literal: ${line}`);
    for (const token of line.matchAll(/var\((--[\w-]+)\)/gu)) if (/stage|mark|surface|ink|line/u.test(token[1])) assert.ok(new RegExp(`${token[1]}:`, 'u').test(defined), `${token[1]} is defined`);
  }
});
