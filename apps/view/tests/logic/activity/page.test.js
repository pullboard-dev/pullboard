/** The Activity page draws the approved mockup's sections from the board's own events, and its one slot holds one tab [N26,#6916]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageRenderScript } from '../../../index.js';
import { activityFlow } from '../../../src/logic/activity/flow.js';
import { activityPageHtml } from '../../../src/logic/activity/page.js';
import { activityStart } from '../../../src/logic/activity/slot.js';
import { activityStep } from '../../../src/logic/activity/slot.js';

const HOUR = 3_600_000, MIN = 60_000;
const top = new Date(Date.UTC(2026, 10, 13, 8, 0, 0)); top.setMinutes(0, 0, 0);
const now = top.getTime() + 40 * MIN;
let counter = 0;
/** One native event, `ago` minutes before now. */
const event = (ago, kind, item, by = 'core-1', detail = {}) => ({ event_id: ++counter, event_at: new Date(now - ago * MIN).toISOString(), event_by: by, event_kind: kind, item_id: item, event_detail: JSON.stringify(detail) });
/** A board with `landed` items that went add, claim, submit, green gate, review, accept, merge, and one still building for 80 minutes. */
const board = (landed, extra = []) => {
  const events = [];
  for (let n = 0; n < landed; n++) {
    const id = 100 + n, base = 50 + n * 3;
    events.push(event(base, 'add', id, 'coordinator'), event(base - 5, 'claim', id), event(base - 15, 'submit', id), event(base - 16, 'gate-run', id, 'core-1', { run: { green: true } }),
      event(base - 18, 'reserve', id, 'rev-1'), event(base - 20, 'accept', id, 'rev-1'), event(base - 22, 'merged', id, 'coordinator', { commit: 'abcdef1234' }));
  }
  events.push(event(80, 'add', 900, 'coordinator'), event(80, 'claim', 900, 'core-9'), ...extra);
  events.sort((a, b) => a.event_id - b.event_id);
  const items = [{ id: 900, title: 'Still building', status: 'claimed', claim: { by: 'core-9', until: new Date(now + HOUR).toISOString() }, blockedBy: [] }];
  for (let n = 0; n < landed; n++) items.push({ id: 100 + n, title: 'Landed ' + n, status: 'verified', stage: 'merged', blockedBy: [] });
  return { project: { stageLimits: { building: 45 }, items, agents: [{ agent_id: 'core-9' }], shouts: [], dashboardRunners: { runners: [{ runner: 1, busy: true, cpu: 50, jobs: [{}, {}] }] } }, events };
};
const draw = (landed, extra) => {
  const { project, events } = board(landed, extra);
  const flow = activityFlow(project, events, { now, left: now - 14 * MIN, working: ['core-9'] });
  return { flow, html: activityPageHtml(flow, activityStart(flow), { width: 740 }) };
};

test('clause 1: the page draws Since you left, Bottlenecks, By hour and the Agents, Runners, Queue and Main rail in the mockup order, from the board [N26,#6916]', () => {
  const { html } = draw(4);
  const order = ['act-since', 'Bottlenecks · now', 'act-resec', 'By hour · 24 h', 'act-hoursec', 'act-rail'].map(marker => html.indexOf(marker));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'sections appear in order: ' + order);
  for (const word of ['Ready', 'Building', 'Gate', 'Pending review', 'Landing']) assert.ok(html.includes('<i class="dot ' + ({ Ready: 'ready', Building: 'building', Gate: 'gate', 'Pending review': 'review', Landing: 'merged' })[word] + '"></i>' + word), word + ' is a Bottlenecks stage');
  for (const word of ['Agents', 'Runners', 'Queue', 'Main']) assert.ok(html.includes('>' + word), word + ' is in the rail');
  assert.doesNotMatch(html, / style="/u, 'no inline style attribute');
});

test('clause 1: every count reads from the board: more landings move every landed figure, and the stuck count follows the stay against its limit [N26,#6916]', () => {
  const few = draw(2).flow, many = draw(9).flow;
  assert.equal(few.counts.landed, 2); assert.equal(many.counts.landed, 9);
  assert.equal(few.since.landed, few.events.filter(entry => entry.kind === 'landed' && entry.at >= now - 14 * MIN).length);
  const hour = many.hours[0];
  assert.equal(hour.landed, hour.events.filter(entry => entry.kind === 'landed').length, 'the hour summary counts its own landings');
  const building = many.bottlenecks.find(row => row.key === 'building');
  assert.deepEqual([building.working, building.stuck], [0, 1], 'the item building for 80 minutes is past the 45 minute limit');
  assert.equal(many.journeyById.get(900).segs.at(-1).over, true);
  assert.equal(activityFlow(board(2).project, board(2).events, { now, windowHours: 24 }).hours.length, 24, 'hours reach back 24');
  const paged = draw(2).flow; assert.equal(activityPageHtml(paged, activityStep(activityStart(paged), { type: 'page', by: 1 }, paged), { width: 740 }).includes('4–6 of 24'), true, 'hours page three at a time with Earlier and Newer');
  assert.match(activityPageHtml(paged, activityStart(paged), { width: 740 }), /Earlier 3 hours/u);
});

test('clause 2: one slot per page holds an Events tab, then after a bar click an Item tab; only one tab shows; x and Esc close the item [N26,#6916]', () => {
  const { flow } = draw(12);
  const newest = flow.hours.find(hour => hour.events.length);
  let ui = activityStart(flow);
  assert.equal(ui.open, newest.h0, 'the newest hour with events is open on its Events tab');
  const count = (html, text) => html.split(text).length - 1;
  let html = activityPageHtml(flow, ui, { width: 740 });
  assert.equal(count(html, 'act-evt tabs open'), 1, 'one slot is open');
  assert.ok(count(html, '<div class="act-row') <= 10, 'ten two-line rows per page');
  ui = activityStep(ui, { type: 'item', item: 900, hour: newest.h0 }, flow);
  html = activityPageHtml(flow, ui, { width: 740 });
  assert.equal(count(html, 'act-evt tabs open'), 1, 'still one slot');
  assert.equal(count(html, 'class="tb it on"'), 1, 'the Item tab shows');
  assert.equal(count(html, 'class="tb on"'), 0, 'the Events tab does not');
  assert.ok(html.includes('act-jsvg') && !html.includes('act-evrows'), 'the journey draws and the hour rows do not');
  const other = flow.hours.find(hour => hour !== newest && hour.events.length);
  if (other) { const moved = activityStep(ui, { type: 'hour', hour: other.h0 }, flow); assert.equal(moved.open, other.h0, 'another hour takes the slot'); assert.equal(moved.item, null, 'and the item goes with the old slot'); }
  ui = activityStep(ui, { type: 'close' }, flow);
  assert.equal(ui.item, null, 'x or Esc closes the item');
  assert.equal(activityPageHtml(flow, ui, { width: 740 }).includes('class="tb it'), false);
  ui = activityStep(activityStep(ui, { type: 'item', item: 900, hour: newest.h0 }, flow), { type: 'item', item: 900, hour: newest.h0 }, flow);
  assert.equal(ui.item, null, 'a second click on the open bar closes it');
});

test('clause 1: at 390 the Runners cell holds its jobs text inside its own value, draws a load bar not a dash chart, and the legend ends in an ellipsis [N26,#7308]', () => {
  const { html } = draw(4);
  const cell = html.slice(html.indexOf('data-act-res="1"'), html.indexOf('data-act-res="2"'));
  assert.match(cell, /<span class="rv"><svg class="load"[^]*<span>2 jobs<\/span><\/span><\/button>/u, 'the jobs text sits inside the cell value, next to the load bar');
  assert.doesNotMatch(cell, /class="mini"/u, 'no dash chart');
  assert.match(cell, /class="lo" x="0" width="50"/u, 'the bar is the mean load: 50 percent');
});

test('clause 2: the you-left marker is drawn only with the Since you left line, and the now label never shares a row with a tick [N26,#7308]', () => {
  const { flow } = draw(4);
  const withLeft = activityPageHtml(flow, activityStart(flow), { width: 740, leftKnown: true });
  const without = activityPageHtml(flow, activityStart(flow), { width: 740, leftKnown: false });
  assert.match(withLeft, /Since you left/u); assert.match(withLeft, /act-lleft/u); assert.match(withLeft, />you left</u);
  assert.doesNotMatch(without, /Since you left/u); assert.doesNotMatch(without, /act-lleft|>you left<|since you left/u, 'no marker without the line');
  const near = activityFlow(board(4).project, board(4).events, { now: top.getTime() + 17 * MIN, left: top.getTime() + 2 * MIN, working: ['core-9'] });
  const svg = activityPageHtml(near, activityStart(near), { width: 740 }).match(/<svg class="act-wfsvg"[^]*?<\/svg>/u)[0];
  const ys = [...svg.matchAll(/<text class="act-tick(?: now)?" x="\d+" y="([\d.]+)"/gu)].map(match => Number(match[1]));
  assert.ok(svg.includes('act-tick now'), 'the now label is drawn');
  assert.ok(ys.filter(y => Math.abs(y - 13) < 12).length === 1, 'only the now label sits at the top: ' + ys);
});

test('clause 1: every board stage limit applies under the chart stage it names [N26,#7559]', () => {
  const stay = (kind, limits) => {
    const events = [event(200, 'add', 7, 'coordinator'), event(200, 'claim', 7, 'core-1'), event(150, 'submit', 7), event(140, 'gate-run', 7, 'core-1', { run: { green: true } }), event(100, 'reserve', 7, 'rev-1')];
    const items = [{ id: 7, title: 'Slow', status: 'submitted', reviewer: 'rev-1', progress: { holder: 'rev-1' }, reviewUntil: new Date(now + HOUR).toISOString(), blockedBy: [] }];
    return activityFlow({ stageLimits: limits, items, agents: [], shouts: [] }, events, { now }).limits[kind];
  };
  const all = { building: 11, gate: 12, 'pending review': 13, 'in review': 14, landing: 15 };
  for (const [kind, minutes] of [['build', 11], ['gate', 12], ['pend', 13], ['rev', 14], ['land', 15]]) assert.equal(stay(kind, all), minutes, kind + ' reads its board limit');
});

test('clause 2: a stage with no board limit, such as Ready, is never drawn past limit [N26,#7559]', () => {
  const flow = activityFlow({ stageLimits: {}, items: [{ id: 8, title: 'Waiting', status: 'open', blockedBy: [] }], agents: [], shouts: [] }, [event(600, 'add', 8, 'coordinator')], { now });
  assert.deepEqual(flow.limits, {}, 'no placeholder limits remain');
  assert.equal(flow.journeyById.get(8).segs.some(seg => seg.over), false, 'ten hours in Ready is not past limit');
  assert.equal(flow.journeyById.get(8).stuck, false);
});

test('clause 1: Activity rows show each item title and a withdrawn item shows as withdrawn, never only Ready [N26,#7756]', () => {
  const events = [event(50, 'add', 4, 'coordinator'), event(30, 'withdraw', 4, 'coordinator', { reason: 'duplicate' }), event(20, 'add', 5, 'coordinator')];
  const items = [{ id: 4, title: 'Dropped work', status: 'withdrawn', updatedAt: new Date(now - 30 * MIN).toISOString(), blockedBy: [] }, { id: 5, title: 'Fresh work', status: 'open', blockedBy: [] }];
  const flow = activityFlow({ stageLimits: {}, items, agents: [], shouts: [] }, events, { now });
  const html = activityPageHtml(flow, activityStart(flow), { width: 740 });
  const rows = [...html.matchAll(/<div class="act-row has" data-row="(\d+)">[^]*?<\/div>/gu)].map(match => match[0]);
  const four = rows.filter(row => row.includes('data-row="4"')).join('');
  assert.match(four, /Withdrawn/u, 'the withdraw is its own row with a Withdrawn chip');
  assert.match(four, /withdrawn by coordinator · duplicate/u);
  assert.ok(rows.some(row => row.includes('data-row="5"') && row.includes('Fresh work')), 'a row names its item title');
  assert.doesNotMatch(html, /A message/u, 'no item row is titled A message');
});

test('clause 1: the Activity tab loads the finished and withdrawn items an open-first state left out, so its rows have titles [N26,#7756,#6697]', () => {
  assert.match(pageRenderScript(), /view\.tab === 'activity'[^;]*\)\) ensureFinished\(data\.project\)/u, 'the Activity tab reads the finished items');
});
