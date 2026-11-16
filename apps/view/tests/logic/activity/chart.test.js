/** @pullboard-test-input apps/view/src/logic/activity/flow.js apps/view/src/logic/activity/page.js apps/view/src/logic/activity/slot.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityFlow } from '../../../src/logic/activity/flow.js';
import { activityPageHtml } from '../../../src/logic/activity/page.js';
import { activityStart } from '../../../src/logic/activity/slot.js';

const MIN = 60_000, HOUR = 3_600_000;
const top = new Date(Date.UTC(2026, 10, 13, 8, 0, 0)); top.setMinutes(0, 0, 0);
const now = top.getTime() + 50 * MIN;
let counter = 0;
const event = (ago, kind, item, by = 'core-1', detail = {}) => ({ event_id: ++counter, event_at: new Date(now - ago * MIN).toISOString(), event_by: by, event_kind: kind, item_id: item, event_detail: JSON.stringify(detail) });
/** `movers` items start building inside the current hour; `waiters` items only sit in Ready; one item builds past the 20 minute limit. */
const draw = (movers, waiters) => {
  const events = [], items = [];
  for (let n = 0; n < movers; n++) { const id = 100 + n; events.push(event(40 - (n % 30), 'add', id, 'coordinator'), event(30 - (n % 25), 'claim', id)); items.push({ id, title: 'Mover ' + id, status: 'claimed', claim: { by: 'core-1', until: new Date(now + HOUR).toISOString() }, blockedBy: [] }); }
  for (let n = 0; n < waiters; n++) { const id = 500 + n; events.push(event(300, 'add', id, 'coordinator')); items.push({ id, title: 'Waiter ' + id, status: 'open', blockedBy: [] }); }
  events.sort((a, b) => a.event_id - b.event_id);
  const flow = activityFlow({ stageLimits: { building: 20 }, items, agents: [], shouts: [] }, events, { now, left: now - 14 * MIN });
  const html = activityPageHtml(flow, activityStart(flow), { width: 778 });
  return { html, svg: html.match(/<svg class="act-wfsvg"[^]*?<\/svg>(<p class="act-wfnote">[^<]*<\/p>)?/u)[0] };
};

test('clause 1: a column per moved item only, capped at 60 with an and N more moved line and a count of items that only waited [N26,#7567]', () => {
  const { svg } = draw(70, 9);
  assert.equal([...svg.matchAll(/<g data-id="(\d+)"/gu)].length, 60, 'sixty columns');
  assert.ok(![...svg.matchAll(/<g data-id="(\d+)"/gu)].some(match => Number(match[1]) >= 500), 'a waiting item has no column');
  assert.match(svg, /and 10 more moved · 9 only waited all hour, counted in Bottlenecks: 9 ready/u);
  const ids = [...svg.matchAll(/<g data-id="(\d+)"/gu)].map(match => Number(match[1]));
  assert.ok(ids.length > 0 && Math.min(...ids) >= 100, 'ordered columns are items that moved');
  assert.doesNotMatch(draw(3, 0).svg, /and \d+ more moved|only waited/u, 'no note when nothing is hidden');
});

test('clause 2: past limit is a thin red cap, the bar keeps its stage colour, and the columns fill the card width [N26,#7567]', () => {
  const { svg } = draw(8, 0);
  assert.match(svg, /<rect class="m-cap"/u, 'a cap is drawn where the 20 minute limit was crossed');
  assert.doesNotMatch(svg, /s-over/u, 'no hatched fill');
  const xs = [...svg.matchAll(/<g data-id="\d+"><rect class="act-hit" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/gu)].map(match => [Number(match[1]), Number(match[2])]);
  const right = Math.max(...xs.map(([x, w]) => x + w));
  assert.ok(Math.min(...xs.map(([, w]) => w)) >= 20, 'columns are wide: ' + xs.map(([, w]) => w));
  assert.ok(right > 8 * 20, 'columns spread across the card: ' + right);
});
